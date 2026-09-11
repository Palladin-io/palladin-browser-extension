import { SharedUnlockExpiryStore } from '../shared-unlock/expiry-store';
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fromBase64, openBrowserSessionEnvelope, toBase64Url, wipe } from "@palladin/crypto";
import { AutoLock, AUTO_LOCK_ALARM } from "./auto-lock";
import { AuthClient } from "./auth-client";
import { SessionHooks } from "./hooks";
import { SessionManager } from "./session-manager";
import { SessionStore } from "./session-store";
import { accountMaterial, buildTestAccount, FakeAlarms, FakeStorageArea, mockBackend, type TestAccount } from "./test-support";
import { MasterPasswordUnlock } from "./unlock-source";
import type { SharedUnlockInstallation } from "./shared-unlock-install";

const apiUrl = "https://api.test";
const sealedKey = "palladin.session.sealed.v1";
let account: TestAccount;
let installation: SharedUnlockInstallation;
beforeAll(async () => {
  account = await buildTestAccount();
  const material = accountMaterial(account);
  const keys = await new MasterPasswordUnlock(account.password).deriveKeys(material);
  installation = {
    tokens: { apiUrl, userId: account.accountId, accessToken: "receiver-own-access", refreshToken: "receiver-own-refresh" },
    material, keys,
    limits: { unlockedAtMs: 900_000, idleDeadlineMs: 1_100_000, absoluteDeadlineMs: 1_300_000, offlineDeadlineMs: 1_200_000 },
  };
});
const fresh = (): SharedUnlockInstallation => ({
  ...installation, keys: { masterKey: installation.keys.masterKey.slice(), privateKey: installation.keys.privateKey.slice() },
});
function harness(storage = new FakeStorageArea(), retireSharedUnlock?: (scope: { userId: string; apiUrl: string }) => void) {
  const now = { value: 1_000_000 };
  const environment = { value: apiUrl };
  const alarms = new FakeAlarms();
  const backend = mockBackend(account);
  const auth = new AuthClient(backend.fetch, () => environment.value);
  const store = new SessionStore(storage);
  const hooks = new SessionHooks();
  let manager: SessionManager;
  const autoLock = new AutoLock(alarms, () => { void manager.lock(); });
  manager = new SessionManager({ store, authClient: auth, autoLock, hooks, ...(retireSharedUnlock ? { retireSharedUnlock } : {}), now: () => now.value });
  return { manager, store, storage, alarms, environment, now, hooks, auth };
}
const erased = (value: SharedUnlockInstallation) => {
  expect(value.keys.masterKey).toEqual(new Uint8Array(32));
  expect(value.keys.privateKey).toEqual(new Uint8Array(32));
};

describe("shared unlock receiver installation", () => {
  it("installs only the receiver tokens, seals them and retains the original limits", async () => {
    const h = harness(); const value = fresh();
    const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
    expect(attempt.completed).toBe(false);
    await attempt.install(value);
    expect(attempt.completed).toBe(true);
    expect(attempt.signal.aborted).toBe(false);
    expect(await h.manager.getStatus()).toBe("unlocked");
    expect(await h.manager.getAccessToken()).toBe("receiver-own-access");
    expect(h.manager.getSharedUnlockLimits()).toEqual(value.limits);
    expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(value.limits.idleDeadlineMs);
    const envelope = (await h.store.getSealedSession())!;
    const bytes = await openBrowserSessionEnvelope(envelope, value.keys.masterKey, { now: () => h.now.value });
    try { expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ state: "active", ...value.tokens }); }
    finally { wipe(bytes); }
    const durable = JSON.stringify(h.storage.values());
    expect(durable).not.toContain(value.tokens.accessToken);
    expect(durable).not.toContain(value.tokens.refreshToken);
    expect(durable).not.toContain(toBase64Url(value.keys.masterKey));
    expect(durable).not.toContain(toBase64Url(value.keys.privateKey));
    // A worker restart cannot recover keys from the durable envelope.
    const restarted = harness(h.storage);
    expect(await restarted.manager.initialize()).toBe("locked");
    expect(restarted.manager.getKeys()).toBeNull();
  });

  for (const action of ["lock", "logout", "cancel", "environment", "route", "new-attempt", "manual-unlock"] as const) {
    it(`rejects an old install after ${action}`, async () => {
      const h = harness(); const value = fresh(); let route = true;
      const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => { if (!route) throw new Error("route changed"); });
      if (action === "lock") await h.manager.lock();
      if (action === "logout") await h.manager.logout();
      if (action === "cancel") attempt.cancel();
      if (action === "environment") h.environment.value = "https://other.test";
      if (action === "route") route = false;
      if (action === "new-attempt") await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
      if (action === "manual-unlock") await h.manager.unlockWithPassword(account.password).catch(() => {});
      await expect(attempt.install(value)).rejects.toThrow();
      erased(value);
      expect(h.manager.getKeys()).toBeNull();
      expect(await h.store.getSealedSession()).toBeNull();
    });
  }

  for (const field of ["idleDeadlineMs", "absoluteDeadlineMs", "offlineDeadlineMs"] as const) {
    it(`does not revive an expired ${field}`, async () => {
      const h = harness(); const value = { ...fresh(), limits: { ...installation.limits, [field]: h.now.value } };
      const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
      await expect(attempt.install(value)).rejects.toThrow(); erased(value);
      expect(h.manager.getKeys()).toBeNull();
    });
  }

  for (const field of ["userId", "apiUrl"] as const) {
    it(`rejects receiver tokens outside selected ${field}`, async () => {
      const h = harness(); const value = { ...fresh(), tokens: { ...installation.tokens, [field]: "foreign" } };
      const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
      await expect(attempt.install(value)).rejects.toThrow(); erased(value);
    });
  }

  it("rejects switching an already bound account", async () => {
    const h = harness();
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    await expect(h.manager.beginSharedUnlockInstall("22222222-2222-4222-8222-222222222222", apiUrl, () => {})).rejects.toThrow();
    expect(await h.manager.getUserId()).toBe(account.accountId);
  });

  for (const action of ["lock", "logout"] as const) {
    it(`preserves the prior locked session only for ${action} during replacement write`, async () => {
      const h = harness();
      await h.manager.login(account.email, account.password);
      await h.manager.lock();
      const previous = await h.store.getSealedSession();
      const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
      const original = h.store.setSealedSession.bind(h.store);
      vi.spyOn(h.store, "setSealedSession").mockImplementationOnce(async envelope => {
        await original(envelope); void h.manager[action]();
      });
      const value = fresh();
      await expect(attempt.install(value)).rejects.toThrow(); erased(value);
      expect(await h.store.getSealedSession()).toEqual(action === "lock" ? previous : null);
      expect(await h.manager.getStatus()).toBe(action === "lock" ? "locked" : "signed-out");
    });
  }

  it("enforces a shorter local policy at key use when the alarm is late", async () => {
    const h = harness(); await h.manager.setAutoLockPolicy("15m");
    const value = { ...fresh(), limits: { ...installation.limits,
      idleDeadlineMs: h.now.value + 3_600_000, absoluteDeadlineMs: h.now.value + 7_200_000,
      offlineDeadlineMs: h.now.value + 7_200_000 } };
    await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
    expect(h.manager.getSharedUnlockLimits()).toEqual({ ...value.limits, idleDeadlineMs: h.now.value + 15 * 60_000 });
    h.now.value += 15 * 60_000;
    expect(h.manager.getSharedUnlockLimits()).toBeNull();
    expect(h.manager.getKeys()).toBeNull(); erased(value);
  });

  it("does not install twice or wipe the active keys on a duplicate", async () => {
    const h = harness(); const value = fresh();
    const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
    await attempt.install(value);
    await expect(attempt.install(value)).rejects.toThrow();
    expect(h.manager.getKeys()).toBe(value.keys);
    expect(value.keys.privateKey).toEqual(fromBase64(account.privateKeyB64));
    const duplicate = fresh();
    await expect(attempt.install(duplicate)).rejects.toThrow(); erased(duplicate);
    expect(await h.manager.getAccessToken()).toBe(value.tokens.accessToken);
    attempt.cancel(); // A late/lost ACK cannot undo an installed independent session.
    expect(h.manager.getKeys()).toBe(value.keys);
  });

  it("a concurrent duplicate neither wipes nor detaches the first installation's buffers", async () => {
    const h = harness(); const value = fresh();
    const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
    const write = h.store.setSealedSession.bind(h.store);
    vi.spyOn(h.store, "setSealedSession").mockImplementationOnce(async envelope => {
      await expect(attempt.install({ ...value })).rejects.toThrow();
      expect(value.keys.masterKey).toEqual(installation.keys.masterKey);
      const duplicate = fresh();
      await expect(attempt.install(duplicate)).rejects.toThrow(); erased(duplicate);
      attempt.cancel();
      erased(value); // Cancellation still owns the original buffers immediately.
      await write(envelope);
    });
    await expect(attempt.install(value)).rejects.toThrow();
    expect(h.manager.getKeys()).toBeNull();
    expect(await h.store.getSealedSession()).toBeNull();
  });

  it("does not start automatic installation while a manual unlock is deriving", async () => {
    const h = harness();
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    let release!: () => void;
    let started!: () => void;
    const deriving = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const unlocking = h.manager.unlock({ id: "manual-test", deriveKeys: async material => {
      started(); await paused;
      return new MasterPasswordUnlock(account.password).deriveKeys(material);
    } });
    await deriving;
    await expect(h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).rejects.toThrow();
    release(); await unlocking;
    expect(await h.manager.getStatus()).toBe("unlocked");
  });

  it("enforces the deadline at key use even when a browser alarm is delayed", async () => {
    const h = harness(); const value = fresh();
    await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
    h.now.value = value.limits.idleDeadlineMs;
    expect(h.manager.getKeys()).toBeNull(); erased(value);
    expect(await h.manager.getStatus()).toBe("locked");
  });

  it("lets actual own activity extend idle only up to original absolute/offline ceilings", async () => {
    const h = harness(); const value = fresh();
    await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
    h.now.value += 5000;
    await h.manager.touchActivity();
    expect(h.manager.getSharedUnlockLimits()).toEqual({ ...value.limits, idleDeadlineMs: value.limits.offlineDeadlineMs });
    expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(value.limits.offlineDeadlineMs);
    h.now.value = value.limits.offlineDeadlineMs;
    await h.manager.touchActivity();
    expect(h.manager.getKeys()).toBeNull(); erased(value);
  });

  it("does not remove inherited expiry when the local policy becomes on-close", async () => {
    const h = harness(); const value = fresh();
    await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
    await h.manager.setAutoLockPolicy("on-close");
    expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(value.limits.idleDeadlineMs);
    expect(h.manager.getSharedUnlockLimits()).toEqual(value.limits);
  });

  for (const boundary of ["envelope-write", "policy-read", "policy-write", "unlocked-hook"] as const) {
    for (const action of ["cancel", "lock", "logout", "expiry"] as const) {
      it(`fences ${action} during ${boundary} and removes only the incomplete own envelope`, async () => {
        const h = harness(); const value = fresh();
        const attempt = await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {});
        const change = () => {
          if (action === "cancel") attempt.cancel();
          if (action === "lock") void h.manager.lock();
          if (action === "logout") void h.manager.logout();
          if (action === "expiry") h.now.value = value.limits.idleDeadlineMs;
        };
        if (boundary === "envelope-write") {
          const original = h.store.setSealedSession.bind(h.store);
          vi.spyOn(h.store, "setSealedSession").mockImplementationOnce(async envelope => { await original(envelope); change(); });
        }
        if (boundary === "policy-read") {
          const original = h.store.getAutoLock.bind(h.store);
          vi.spyOn(h.store, "getAutoLock").mockImplementationOnce(async () => { const result = await original(); change(); return result; });
        }
        if (boundary === "policy-write") {
          const original = h.store.setAutoLock.bind(h.store);
          vi.spyOn(h.store, "setAutoLock").mockImplementationOnce(async record => { await original(record); change(); });
        }
        if (boundary === "unlocked-hook") h.hooks.onUnlocked(change);
        await expect(attempt.install(value)).rejects.toThrow();
        erased(value);
        expect(h.manager.getKeys()).toBeNull();
        expect(await h.manager.getAccessToken()).toBeNull();
        expect(await h.store.getSealedSession()).toBeNull();
        expect(h.storage.has(sealedKey)).toBe(false);
      });
    }
  }
});

it('retires the verified own authorization at the exact key-use deadline and preserves the barrier after restart', async () => {
  const storage = new FakeStorageArea();
  const expiry = new SharedUnlockExpiryStore(storage);
  const scope = { accountId: account.accountId, apiUrl };
  expiry.remember(scope, 5);
  const h = harness(storage, own => expiry.retire({ accountId: own.userId, apiUrl: own.apiUrl }));
  const value = fresh();
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  h.now.value = value.limits.idleDeadlineMs;
  expect(h.manager.getKeys()).toBeNull();
  erased(value);
  await expect(expiry.assertFresh(scope, 5)).rejects.toThrow('retired locally');
  await expect(new SharedUnlockExpiryStore(storage).assertFresh(scope, 5)).rejects.toThrow('retired locally');
  await expect(expiry.assertFresh(scope, 6)).resolves.toBeUndefined();
});
it('destroys keys even when the local retirement callback fails', async () => {
  const h = harness(new FakeStorageArea(), () => { throw new Error('unavailable'); });
  const value = fresh();
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  await h.manager.lock();
  erased(value); expect(h.manager.getKeys()).toBeNull();
});

it('checkpoints effective local idle before publishing keys and arms the saved earlier deadline', async () => {
  const h = harness(); await h.manager.setAutoLockPolicy('15m');
  const value = fresh();
  const limits = { ...value.limits, idleDeadlineMs: h.now.value + 5_000_000,
    absoluteDeadlineMs: h.now.value + 6_000_000, offlineDeadlineMs: h.now.value + 6_000_000 };
  const savedDeadline = h.now.value + 500;
  const checkpoint = vi.fn(async (deadline: number) => {
    expect(deadline).toBe(h.now.value + 15 * 60_000);
    expect(h.manager.getKeys()).toBeNull();
    return savedDeadline;
  });
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install({ ...value, limits, checkpoint });
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(savedDeadline);
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(savedDeadline);
  h.now.value = savedDeadline;
  expect(h.manager.getKeys()).toBeNull(); erased(value);
});
