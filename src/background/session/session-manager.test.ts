import { beforeEach, describe, expect, it } from "vitest";

import { AuthClient } from "./auth-client";
import { AutoLock, AUTO_LOCK_ALARM } from "./auto-lock";
import { SessionHooks } from "./hooks";
import { SessionManager } from "./session-manager";
import { SessionStore } from "./session-store";
import { MasterPasswordUnlock } from "./unlock-source";
import { SessionError } from "./types";
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
}

function makeHarness(account: TestAccount, opts: MockBackendOptions = {}): Harness {
  const storage = new FakeStorageArea();
  const alarms = new FakeAlarms();
  const store = new SessionStore(storage);
  const authClient = new AuthClient(mockBackend(account, opts).fetch, "http://api.test");
  const hooks = new SessionHooks();
  const now = { value: 1_000_000 };
  let mgr: SessionManager;
  const autoLock = new AutoLock(alarms, () => void mgr.lock());
  alarms.onFire((name) => autoLock.dispatch(name));
  mgr = new SessionManager({ store, authClient, autoLock, hooks, now: () => now.value });
  return { mgr, storage, alarms, hooks, now };
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
});
