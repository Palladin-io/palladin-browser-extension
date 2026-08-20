import {
  fromBase64Url,
  openBrowserSessionEnvelope,
  toBase64Url,
  wipe,
  type BrowserSessionEnvelope,
} from "@palladin/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthClient } from "./auth-client";
import { AutoLock, AUTO_LOCK_ALARM } from "./auto-lock";
import { SessionHooks } from "./hooks";
import {
  DURABLE_SESSION_TTL_MS,
  PENDING_TOTP_TTL_MS,
  SessionManager,
  type SessionManagerDeps,
} from "./session-manager";
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

const SEALED_SESSION_KEY = "palladin.session.sealed.v1";

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
  overrides: Pick<
    SessionManagerDeps,
    | "clientId"
    | "createPasswordUnlock"
    | "durableSessionTtlMs"
    | "pendingTotpTimers"
  > = {},
): Harness {
  const storage = new FakeStorageArea();
  const alarms = new FakeAlarms();
  const store = new SessionStore(storage);
  const backend = mockBackend(account, opts);
  const authClient = new AuthClient(backend.fetch, "https://api.test");
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

async function readEnvelope(storage: FakeStorageArea): Promise<BrowserSessionEnvelope> {
  const value = (await storage.get([SEALED_SESSION_KEY]))[SEALED_SESSION_KEY];
  if (!value) throw new Error("Expected a sealed session fixture");
  return value as BrowserSessionEnvelope;
}

async function readSealedPayload(
  envelope: BrowserSessionEnvelope,
  masterKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const plaintext = await openBrowserSessionEnvelope(envelope, masterKey);
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  } finally {
    wipe(plaintext);
  }
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
    // Tokens are never plaintext in storage; only one authenticated envelope is durable.
    expect(storage.keys()).not.toContain("palladin.session.keys");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(true);
    expect(JSON.stringify(storage.values())).not.toContain("access-token-1");
    expect(JSON.stringify(storage.values())).not.toContain("refresh-token-1");
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
    expect(storage.has(SEALED_SESSION_KEY)).toBe(true);
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
  }, 15_000);

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

  it("cancels an earlier login before lock can publish its derived keys", async () => {
    const { mgr, storage, alarms, hooks } = makeHarness(account);
    const originalSet = storage.set.bind(storage);
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    vi.spyOn(storage, "set").mockImplementationOnce(async (items) => {
      saveStarted.resolve();
      await releaseSave.promise;
      return originalSet(items);
    });
    const unlocked = vi.fn();
    hooks.onUnlocked(unlocked);
    const login = mgr.login(account.email, account.password);
    const cancelled = expect(login).rejects.toThrow("Session lifecycle changed");
    await saveStarted.promise;

    await mgr.lock();
    releaseSave.resolve();
    await cancelled;

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

  it("does not let a stalled remote revocation block the authoritative local logout", async () => {
    const stalledLogout = deferred<Response>();
    const { mgr, storage } = makeHarness(account, { logoutResponse: stalledLogout.promise });
    await mgr.login(account.email, account.password);

    await expect(mgr.logout()).resolves.toBeUndefined();

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
    await expect(mgr.completeTotp("challenge", "123456")).rejects.toThrow(
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

    expect(events).toEqual([
      `unlocked:${account.accountId}`,
      `locked:${account.accountId}`,
    ]);
  });
});

describe("SessionManager — service-worker restart", () => {
  it("fails closed to locked because key material is never stored", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");

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

  it("treats extension Reload and a compatible update as locked, never unlocked", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const clientId = "stable-browser-extension-id";
    const now = { value: 4_000_000 };
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      clientId,
      now: () => now.value,
    });
    await first.login(account.email, account.password);

    // A new worker instance models explicit Reload, update, disable/enable, or
    // browser restart. Compatible code keeps the stable runtime ID/protocol.
    const afterUpdate = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      clientId,
      now: () => now.value,
    });

    expect(await afterUpdate.initialize()).toBe("locked");
    expect(afterUpdate.getKeys()).toBeNull();
    expect(await afterUpdate.getAccessToken()).toBeNull();
  });

  it("keeps a valid envelope after a wrong password, then unlocks with the correct one", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    await first.login(account.email, account.password);
    const before = await readEnvelope(storage);
    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });

    await expect(restarted.unlockWithPassword("wrong password")).rejects.toMatchObject({
      code: "incorrect-password",
    });
    expect(await readEnvelope(storage)).toEqual(before);
    expect(await restarted.getStatus()).toBe("locked");

    await restarted.unlockWithPassword(account.password);
    expect(await restarted.getStatus()).toBe("unlocked");
  });

  it("preserves KDF/private-key context tamper as locked because it is indistinguishable from a wrong password", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    await first.login(account.email, account.password);
    const envelope = await readEnvelope(storage);
    const wrapped = fromBase64Url(envelope.context.encryptedPrivateKey);
    wrapped[wrapped.length - 1] ^= 1;
    await storage.set({
      [SEALED_SESSION_KEY]: {
        ...envelope,
        context: {
          ...envelope.context,
          encryptedPrivateKey: toBase64Url(wrapped),
        },
      },
    });
    wipe(wrapped);
    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });

    expect(await restarted.initialize()).toBe("locked");
    await expect(restarted.unlockWithPassword(account.password)).rejects.toMatchObject({
      code: "incorrect-password",
    });
    expect(await restarted.getStatus()).toBe("locked");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(true);
  });

  it("deletes authenticated ciphertext tamper after the correct password derives the MK", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    await first.login(account.email, account.password);
    const envelope = await readEnvelope(storage);
    const payload = fromBase64Url(envelope.encodedSuitePayload);
    payload[payload.length - 1] ^= 1;
    await storage.set({
      [SEALED_SESSION_KEY]: {
        ...envelope,
        encodedSuitePayload: toBase64Url(payload),
      },
    });
    wipe(payload);

    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    expect(await restarted.initialize()).toBe("locked");
    await expect(restarted.unlockWithPassword(account.password)).rejects.toMatchObject({
      code: "not-authenticated",
    });
    expect(await restarted.getStatus()).toBe("signed-out");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(false);
  });

  it("deletes a session bound to another extension runtime ID", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      clientId: "first-extension-runtime",
    });
    await first.login(account.email, account.password);
    const foreignRuntime = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      clientId: "different-extension-runtime",
    });

    expect(await foreignRuntime.initialize()).toBe("signed-out");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(false);
  });

  it("deletes an unsupported durable-session protocol without attempting auth", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const backend = mockBackend(account);
    const authClient = new AuthClient(backend.fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    await first.login(account.email, account.password);
    const envelope = await readEnvelope(storage);
    await storage.set({ [SEALED_SESSION_KEY]: { ...envelope, protocolVersion: 2 } });
    const callsBeforeRestart = backend.calls.length;
    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });

    expect(await restarted.initialize()).toBe("signed-out");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(false);
    expect(backend.calls).toHaveLength(callsBeforeRestart);
  });

  it("expires at the absolute refresh-session deadline, not access-token expiry", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const now = { value: 10_000 };
    const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      now: () => now.value,
    });
    await first.login(account.email, account.password);
    const envelope = await readEnvelope(storage);
    expect(envelope.context.expiresAt - envelope.context.issuedAt).toBe(
      DURABLE_SESSION_TTL_MS,
    );

    now.value = envelope.context.expiresAt;
    const expired = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      now: () => now.value,
    });
    expect(await expired.initialize()).toBe("signed-out");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(false);
  });

  it("purges obsolete plaintext session-only records instead of migrating them", async () => {
    const account = await buildTestAccount();
    const durable = new FakeStorageArea();
    const legacy = new FakeStorageArea();
    await legacy.set({
      "palladin.session.tokens": {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        userId: account.accountId,
        apiUrl: "https://api.test",
      },
      "palladin.session.material": { encryptedPrivateKey: account.encryptedPrivateKey },
    });
    const manager = new SessionManager({
      store: new SessionStore(durable, legacy),
      authClient: new AuthClient(mockBackend(account).fetch, "https://api.test"),
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });

    expect(await manager.initialize()).toBe("signed-out");
    expect(legacy.keys()).toHaveLength(0);
    expect(durable.keys()).toHaveLength(0);
  });

  it("locked-screen logout clears the durable envelope locally without claiming remote revocation", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const backend = mockBackend(account);
    const authClient = new AuthClient(backend.fetch, "https://api.test");
    const first = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
    });
    await first.login(account.email, account.password);
    const restartedHooks = new SessionHooks();
    const lockedEvents: string[] = [];
    restartedHooks.onLocked(({ userId }) => lockedEvents.push(userId));
    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      hooks: restartedHooks,
    });
    expect(await restarted.initialize()).toBe("locked");
    const logoutCallsBefore = backend.calls.filter((url) => url.endsWith("/api/auth/logout"))
      .length;

    await restarted.logout();

    expect(await restarted.getStatus()).toBe("signed-out");
    expect(storage.has(SEALED_SESSION_KEY)).toBe(false);
    expect(lockedEvents).toEqual([account.accountId]);
    expect(backend.calls.filter((url) => url.endsWith("/api/auth/logout"))).toHaveLength(
      logoutCallsBefore,
    );
  });
});

describe("SessionManager - durable refresh rotation", () => {
  it("commits pending then active envelopes before publishing rotated tokens", async () => {
    const account = await buildTestAccount();
    const { mgr, storage, backendCalls } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const masterKey = new Uint8Array(mgr.getKeys()!.masterKey);
    const writes: BrowserSessionEnvelope[] = [];
    const originalSet = storage.set.bind(storage);
    vi.spyOn(storage, "set").mockImplementation(async (items) => {
      const candidate = items[SEALED_SESSION_KEY];
      if (candidate) writes.push(candidate as BrowserSessionEnvelope);
      await originalSet(items);
    });

    try {
      await expect(mgr.refreshAccessToken()).resolves.toBe("access-token-1");
      expect(writes).toHaveLength(2);
      expect((await readSealedPayload(writes[0], masterKey))["state"])
        .toBe("refresh-pending");
      expect((await readSealedPayload(writes[1], masterKey))["state"])
        .toBe("active");
      expect(backendCalls.filter((url) => url.endsWith("/api/auth/refresh")))
        .toHaveLength(1);
      expect(await mgr.getAccessToken()).toBe("access-token-1");
    } finally {
      wipe(masterKey);
    }
  });

  it("leaves a pending marker on a crash window and requires re-auth after restart", async () => {
    const account = await buildTestAccount();
    const { mgr, storage, now, backendCalls } = makeHarness(account);
    await mgr.login(account.email, account.password);
    const replacementWriteStarted = deferred<void>();
    const releaseReplacementWrite = deferred<void>();
    const originalSet = storage.set.bind(storage);
    let envelopeWrites = 0;
    vi.spyOn(storage, "set").mockImplementation(async (items) => {
      if (items[SEALED_SESSION_KEY]) {
        envelopeWrites += 1;
        if (envelopeWrites === 2) {
          replacementWriteStarted.resolve();
          await releaseReplacementWrite.promise;
          throw new Error("simulated durable commit failure");
        }
      }
      await originalSet(items);
    });

    const refreshing = mgr.refreshAccessToken();
    await replacementWriteStarted.promise;
    const restarted = new SessionManager({
      store: new SessionStore(storage),
      authClient: new AuthClient(mockBackend(account).fetch, "https://api.test"),
      autoLock: new AutoLock(new FakeAlarms(), () => {}),
      now: () => now.value,
    });
    expect(await restarted.initialize()).toBe("locked");
    await expect(restarted.unlockWithPassword(account.password)).rejects.toMatchObject({
      code: "not-authenticated",
    });
    expect(await restarted.getStatus()).toBe("signed-out");

    releaseReplacementWrite.resolve();
    await expect(refreshing).resolves.toBeNull();
    expect(await mgr.getStatus()).toBe("signed-out");
    expect(mgr.getKeys()).toBeNull();
    expect(backendCalls.filter((url) => url.endsWith("/api/auth/refresh")))
      .toHaveLength(1);
  });

  it("does not contact the refresh endpoint when the pending marker cannot commit", async () => {
    const account = await buildTestAccount();
    const { mgr, storage, backendCalls } = makeHarness(account);
    await mgr.login(account.email, account.password);
    vi.spyOn(storage, "set").mockRejectedValueOnce(new Error("durable storage unavailable"));

    await expect(mgr.refreshAccessToken()).rejects.toThrow("durable storage unavailable");
    expect(backendCalls.filter((url) => url.endsWith("/api/auth/refresh")))
      .toHaveLength(0);
    expect(await mgr.getStatus()).toBe("unlocked");
  });
});

describe("SessionManager — TOTP second factor", () => {
  it("surfaces a challenge, then unlocks after completing TOTP", async () => {
    const account = await buildTestAccount();
    const { mgr } = makeHarness(account, { totpRequired: true, totpCode: "424242" });

    const start = await mgr.login(account.email, account.password);
    expect(start).toEqual({ status: "totp-required", challengeToken: "challenge-1" });
    expect(await mgr.getStatus()).toBe("signed-out");

    await mgr.completeTotp("challenge-1", "424242");
    expect(await mgr.getStatus()).toBe("unlocked");
    expect(toBase64(mgr.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("expires a pending TOTP key even when the popup never cancels", async () => {
    const timer = { expire: null as (() => void) | null };
    const cancel = vi.fn();
    const schedule = vi.fn((callback: () => void, _delayMs: number): unknown => {
      timer.expire = callback;
      return "totp-timeout";
    });
    const account = await buildTestAccount();
    const { mgr, backendCalls } = makeHarness(
      account,
      { totpRequired: true, totpCode: "424242" },
      { pendingTotpTimers: { schedule, cancel } },
    );

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({
      status: "totp-required",
      challengeToken: "challenge-1",
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), PENDING_TOTP_TTL_MS);

    if (timer.expire === null) throw new Error("TOTP expiry was not scheduled");
    timer.expire();

    await expect(mgr.completeTotp("challenge-1", "424242"))
      .rejects.toMatchObject({ name: "SessionError", code: "network" });
    expect(backendCalls.filter((url) => url.endsWith("/api/auth/login/totp"))).toEqual([]);
    expect(await mgr.getStatus()).toBe("signed-out");
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

    await expect(manager.completeTotp("challenge-1", "424242"))
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

    await expect(mgr.completeTotp("challenge-1", "424242"))
      .rejects.toMatchObject({ name: "SessionError", code: "network" });
    expect(backendCalls.filter((url) => url.endsWith("/api/auth/login/totp"))).toEqual([]);
  });
});
