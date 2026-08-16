import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthClient } from "./auth-client";
import { AutoLock, AUTO_LOCK_ALARM } from "./auto-lock";
import { SessionHooks } from "./hooks";
import { SessionManager, type SessionManagerDeps } from "./session-manager";
import { SessionStore } from "./session-store";
import { MasterPasswordUnlock, type UnlockSource } from "./unlock-source";
import { SessionError, type SessionKeys } from "./types";
import {
  buildTestAccount,
  FakeAlarms,
  FakeStorageArea,
  mockBackend,
  toBase64,
  type MockBackendOptions,
  type TestAccount,
} from "./test-support";

const TOKENS_KEY = "palladin.session.tokens";
const MATERIAL_KEY = "palladin.session.material";

interface Harness {
  mgr: SessionManager;
  storage: FakeStorageArea;
  alarms: FakeAlarms;
  hooks: SessionHooks;
  now: { value: number };
  backendCalls: string[];
}

function makeHarness(
  account: TestAccount,
  opts: MockBackendOptions = {},
  overrides: Pick<SessionManagerDeps, "createPasswordUnlock"> = {},
): Harness {
  const storage = new FakeStorageArea();
  const alarms = new FakeAlarms();
  const store = new SessionStore(storage);
  const backend = mockBackend(account, opts);
  const authClient = new AuthClient(backend.fetch, "http://api.test");
  const hooks = new SessionHooks();
  const now = { value: 1_000_000 };
  let mgr: SessionManager;
  const autoLock = new AutoLock(alarms, () => void mgr.lock());
  alarms.onFire((name) => autoLock.dispatch(name));
  mgr = new SessionManager({
    store,
    authClient,
    autoLock,
    hooks,
    now: () => now.value,
    ...overrides,
  });
  return { mgr, storage, alarms, hooks, now, backendCalls: backend.calls };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredUnlock(): {
  source: UnlockSource;
  keys: SessionKeys;
  started: Promise<void>;
  release(): void;
} {
  const keys: SessionKeys = {
    masterKey: new Uint8Array(32).fill(0x41),
    privateKey: new Uint8Array(32).fill(0x42),
  };
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const pending = new Promise<SessionKeys>((resolve) => {
    release = () => resolve(keys);
  });
  return {
    keys,
    started,
    release,
    source: {
      id: "deferred-test",
      deriveKeys: () => {
        markStarted();
        return pending;
      },
    },
  };
}

describe("SessionManager — full lifecycle", () => {
  let account: TestAccount;
  beforeEach(async () => {
    account = await buildTestAccount();
  });

  it("logs in, unlocks, and recovers the private key from the wrapped blob", async () => {
    const { mgr, storage } = makeHarness(account);

    const result = await mgr.login(account.email, account.password);

    expect(result).toEqual({ status: "unlocked" });
    expect(await mgr.getStatus()).toBe("unlocked");
    const keys = mgr.getKeys();
    expect(keys).not.toBeNull();
    expect(toBase64(keys!.privateKey)).toBe(account.privateKeyB64);
    // Only tokens and encrypted account material land in storage.session.
    expect(storage.keys()).not.toContain("palladin.session.keys");
    expect(storage.has(TOKENS_KEY)).toBe(true);
    expect(storage.has(MATERIAL_KEY)).toBe(true);
  });

  it("rejects a wrong password at login without unlocking", async () => {
    const { mgr } = makeHarness(account);
    await expect(mgr.login(account.email, "wrong password")).rejects.toBeInstanceOf(SessionError);
    expect(await mgr.getStatus()).toBe("signed-out");
    expect(mgr.getKeys()).toBeNull();
  });

  it("lock wipes the key buffers and drops the stored keys, keeping tokens", async () => {
    const { mgr, storage } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const liveMasterKey = mgr.getKeys()!.masterKey;

    await mgr.lock();

    expect(await mgr.getStatus()).toBe("locked");
    expect(mgr.getKeys()).toBeNull();
    // The in-memory buffer was zeroed in place, not merely dereferenced.
    expect(liveMasterKey.every((b) => b === 0)).toBe(true);
    expect(storage.keys()).not.toContain("palladin.session.keys");
    expect(storage.has(TOKENS_KEY)).toBe(true);
    expect(storage.has(MATERIAL_KEY)).toBe(true);
  });

  it("wipes keys synchronously when lock storage lookup fails", async () => {
    const { mgr, storage } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const liveMasterKey = mgr.getKeys()!.masterKey;
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("storage unavailable"));

    const locking = mgr.lock();

    expect(mgr.getKeys()).toBeNull();
    expect(liveMasterKey.every((byte) => byte === 0)).toBe(true);
    await expect(locking).rejects.toThrow("storage unavailable");

    await mgr.unlockWithPassword(account.password);
    expect(mgr.getKeys()).not.toBeNull();
  });

  it("blocks a new unlock for the entire in-flight lock", async () => {
    const { mgr, storage, alarms, hooks } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const originalGet = storage.get.bind(storage);
    const getStarted = deferred<void>();
    const releaseGet = deferred<void>();
    vi.spyOn(storage, "get").mockImplementationOnce(async (keys) => {
      getStarted.resolve();
      await releaseGet.promise;
      return originalGet(keys);
    });
    const candidate: SessionKeys = {
      masterKey: new Uint8Array(32).fill(0x51),
      privateKey: new Uint8Array(32).fill(0x52),
    };
    const deriveKeys = vi.fn(async () => candidate);
    const source: UnlockSource = { id: "lock-race", deriveKeys };
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);

    const locking = mgr.lock();
    await getStarted.promise;
    await expect(mgr.unlock(source)).rejects.toThrow("Session lifecycle changed");

    expect(deriveKeys).not.toHaveBeenCalled();
    expect(mgr.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
    expect(unlocked).not.toHaveBeenCalled();

    releaseGet.resolve();
    await locking;
    await mgr.unlock(source);

    expect(deriveKeys).toHaveBeenCalledTimes(1);
    expect(mgr.getKeys()).toBe(candidate);
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(true);
    expect(unlocked).toHaveBeenCalledTimes(1);
  });

  it("cancels an earlier login before lock can be undone by its derived keys", async () => {
    const candidate = deferredUnlock();
    const { mgr, alarms, hooks } = makeHarness(account, {}, {
      createPasswordUnlock: () => candidate.source,
    });
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);
    const login = mgr.login(account.email, account.password);
    const cancelled = expect(login).rejects.toThrow("Session lifecycle changed");
    await candidate.started;

    await mgr.lock();
    candidate.release();
    await cancelled;

    expect(candidate.keys.masterKey.every((byte) => byte === 0)).toBe(true);
    expect(candidate.keys.privateKey.every((byte) => byte === 0)).toBe(true);
    expect(mgr.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
    expect(unlocked).not.toHaveBeenCalled();
  });

  it("unlock re-derives keys offline from cached material after a lock", async () => {
    const { mgr } = makeHarness(account);
    await mgr.login(account.email, account.password);
    await mgr.lock();

    await mgr.unlockWithPassword(account.password);

    expect(await mgr.getStatus()).toBe("unlocked");
    expect(toBase64(mgr.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("unlock with the wrong password throws incorrect-password and stays locked", async () => {
    const { mgr } = makeHarness(account);
    await mgr.login(account.email, account.password);
    await mgr.lock();

    await expect(mgr.unlockWithPassword("nope")).rejects.toMatchObject({
      code: "incorrect-password",
    });
    expect(await mgr.getStatus()).toBe("locked");
    expect(mgr.getKeys()).toBeNull();
  });

  it("unlock via the injected UnlockSource contract works the same way", async () => {
    const { mgr } = makeHarness(account);
    await mgr.login(account.email, account.password);
    await mgr.lock();

    await mgr.unlock(new MasterPasswordUnlock(account.password));
    expect(toBase64(mgr.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("logout wipes keys and clears every session entry", async () => {
    const { mgr, storage } = makeHarness(account);
    await mgr.login(account.email, account.password);

    await mgr.logout();

    expect(await mgr.getStatus()).toBe("signed-out");
    expect(mgr.getKeys()).toBeNull();
    expect(storage.keys()).toHaveLength(0);
  });

  it("wipes keys synchronously when logout storage lookup fails", async () => {
    const { mgr, storage } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const livePrivateKey = mgr.getKeys()!.privateKey;
    vi.spyOn(storage, "get").mockRejectedValueOnce(new Error("storage unavailable"));

    const loggingOut = mgr.logout();

    expect(mgr.getKeys()).toBeNull();
    expect(livePrivateKey.every((byte) => byte === 0)).toBe(true);
    await expect(loggingOut).rejects.toThrow("storage unavailable");

    await mgr.unlockWithPassword(account.password);
    expect(mgr.getKeys()).not.toBeNull();
  });

  it("blocks new authentication until logout clearAll finishes", async () => {
    const { mgr, storage, alarms, hooks, backendCalls } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const originalRemove = storage.remove.bind(storage);
    const clearAllStarted = deferred<void>();
    const releaseClearAll = deferred<void>();
    vi.spyOn(storage, "remove").mockImplementationOnce(async (keys) => {
      clearAllStarted.resolve();
      await releaseClearAll.promise;
      return originalRemove(keys);
    });
    const deriveKeys = vi.fn(async (): Promise<SessionKeys> => ({
      masterKey: new Uint8Array(32).fill(0x61),
      privateKey: new Uint8Array(32).fill(0x62),
    }));
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);

    const loggingOut = mgr.logout();
    await clearAllStarted.promise;
    const callsBeforeBlockedAttempts = backendCalls.length;
    await expect(mgr.login(account.email, account.password)).rejects.toThrow(
      "Session lifecycle changed",
    );
    await expect(mgr.completeTotp("challenge", "123456", account.password)).rejects.toThrow(
      "Session lifecycle changed",
    );
    await expect(mgr.unlock({ id: "logout-race", deriveKeys })).rejects.toThrow(
      "Session lifecycle changed",
    );

    expect(backendCalls).toHaveLength(callsBeforeBlockedAttempts);
    expect(deriveKeys).not.toHaveBeenCalled();
    expect(storage.keys().length).toBeGreaterThan(0);
    expect(mgr.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
    expect(unlocked).not.toHaveBeenCalled();

    releaseClearAll.resolve();
    await loggingOut;
    expect(storage.keys()).toHaveLength(0);

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({
      status: "unlocked",
    });
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(true);
    expect(unlocked).toHaveBeenCalledTimes(1);
  });

  it("keeps the logout gate active through a failing clearAll", async () => {
    const { mgr, storage, alarms, hooks } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const clearAllStarted = deferred<void>();
    const releaseClearAll = deferred<void>();
    vi.spyOn(storage, "remove").mockImplementationOnce(async () => {
      clearAllStarted.resolve();
      await releaseClearAll.promise;
      throw new Error("clearAll unavailable");
    });
    const candidate: SessionKeys = {
      masterKey: new Uint8Array(32).fill(0x71),
      privateKey: new Uint8Array(32).fill(0x72),
    };
    const deriveKeys = vi.fn(async () => candidate);
    const source: UnlockSource = { id: "logout-error", deriveKeys };
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);

    const loggingOut = mgr.logout();
    const failed = expect(loggingOut).rejects.toThrow("clearAll unavailable");
    await clearAllStarted.promise;
    await expect(mgr.unlock(source)).rejects.toThrow("Session lifecycle changed");

    expect(deriveKeys).not.toHaveBeenCalled();
    expect(mgr.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
    expect(unlocked).not.toHaveBeenCalled();

    releaseClearAll.resolve();
    await failed;
    await mgr.unlock(source);

    expect(deriveKeys).toHaveBeenCalledTimes(1);
    expect(mgr.getKeys()).toBe(candidate);
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(true);
    expect(unlocked).toHaveBeenCalledTimes(1);
  });

  it("cancels an earlier unlock before logout can be undone by its derived keys", async () => {
    const { mgr, storage, alarms, hooks } = makeHarness(account);
    await mgr.login(account.email, account.password);
    await mgr.lock();
    const candidate = deferredUnlock();
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);
    const unlocking = mgr.unlock(candidate.source);
    const cancelled = expect(unlocking).rejects.toThrow("Session lifecycle changed");
    await candidate.started;

    await mgr.logout();
    candidate.release();
    await cancelled;

    expect(candidate.keys.masterKey.every((byte) => byte === 0)).toBe(true);
    expect(candidate.keys.privateKey.every((byte) => byte === 0)).toBe(true);
    expect(mgr.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
    expect(unlocked).not.toHaveBeenCalled();
    expect(storage.keys()).toHaveLength(0);
  });

  it("emits unlocked then locked lifecycle hooks", async () => {
    const { mgr, hooks } = makeHarness(account);
    const events: string[] = [];
    hooks.onUnlocked((e) => events.push(`unlocked:${e.userId}`));
    hooks.onLocked((e) => events.push(`locked:${e.userId}`));

    await mgr.login(account.email, account.password);
    await mgr.lock();

    expect(events).toEqual(["unlocked:user-1", "locked:user-1"]);
  });
});

describe("SessionManager — service-worker restart", () => {
  it("fails closed to locked because key material is never stored", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    const authClient = new AuthClient(mockBackend(account).fetch, "http://api.test");

    // First worker instance: log in, keys exist only in that manager's memory.
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(alarms, () => {}),
    });
    await first.login(account.email, account.password);

    // Worker torn down and restarted: a BRAND-NEW manager over the same storage.
    const second = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(alarms, () => {}),
    });

    expect(await second.initialize()).toBe("locked");
    expect(second.getKeys()).toBeNull();
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);

    await second.unlockWithPassword(account.password);
    expect(await second.getStatus()).toBe("unlocked");
    expect(toBase64(second.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("never reuses a stored session after the configured server changes", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient: new AuthClient(mockBackend(account).fetch, "https://old.example.com"),
      autoLock: new AutoLock(alarms, () => {}),
    });
    await first.login(account.email, account.password);

    const secondBackend = mockBackend(account);
    const second = new SessionManager({
      store: new SessionStore(storage),
      authClient: new AuthClient(secondBackend.fetch, "https://new.example.com"),
      autoLock: new AutoLock(alarms, () => {}),
    });

    expect(await second.initialize()).toBe("signed-out");
    expect(storage.keys()).toHaveLength(0);
    expect(secondBackend.calls).toHaveLength(0);
  });
});

describe("SessionManager — TOTP second factor", () => {
  it("surfaces a challenge, then unlocks after completing TOTP", async () => {
    const account = await buildTestAccount();
    const { mgr } = makeHarness(account, { totpRequired: true, totpCode: "424242" });

    const start = await mgr.login(account.email, account.password);
    expect(start).toEqual({ status: "totp-required", challengeToken: "challenge-1" });
    expect(await mgr.getStatus()).toBe("signed-out");

    await mgr.completeTotp("challenge-1", "424242", account.password);
    expect(await mgr.getStatus()).toBe("unlocked");
    expect(toBase64(mgr.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("never sends a pending production challenge to a newly selected host", async () => {
    const account = await buildTestAccount();
    const backend = mockBackend(account, { totpRequired: true, totpCode: "424242" });
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    let apiUrl = "https://api.palladin.io";
    const manager = new SessionManager({
      store: new SessionStore(storage),
      authClient: new AuthClient(backend.fetch, () => apiUrl),
      autoLock: new AutoLock(alarms, () => {}),
    });
    await manager.login(account.email, account.password);
    apiUrl = "https://self-host.example.com";

    await expect(manager.completeTotp("challenge-1", "424242", account.password))
      .rejects.toMatchObject({ name: "SessionError", code: "network" });
    expect(backend.calls.filter((url) => url.endsWith("/api/auth/login/totp"))).toEqual([]);
    expect(await manager.getStatus()).toBe("signed-out");
  });

  it("invalidates the background challenge when the popup cancels TOTP", async () => {
    const account = await buildTestAccount();
    const { mgr, backendCalls } = makeHarness(account, {
      totpRequired: true,
      totpCode: "424242",
    });
    await mgr.login(account.email, account.password);
    mgr.cancelTotp();

    await expect(mgr.completeTotp("challenge-1", "424242", account.password))
      .rejects.toMatchObject({ name: "SessionError", code: "network" });
    expect(backendCalls.filter((url) => url.endsWith("/api/auth/login/totp"))).toEqual([]);
  });
});
