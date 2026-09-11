import { recordExtensionOwnPolicy } from "../shared-unlock/own-policy-runtime";
import { SharedUnlockApi } from "../shared-unlock/api";
import { SharedUnlockSourceAuthority } from "../shared-unlock/source-authority";
import { OwnSharedUnlockActivityRecorder } from "../shared-unlock/own-activity";
import { recordExtensionOwnActivity } from "../shared-unlock/own-activity-runtime";
import sharedUnlockFixtures from "../shared-unlock/fixtures/session-api-v1.json";
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
function harness(storage = new FakeStorageArea(), retireSharedUnlock?: (scope: { userId: string; apiUrl: string }) => void, onOwnActivity?: () => void, onOwnPolicyChanged?: () => Promise<void>) {
  const now = { value: 1_000_000 };
  const environment = { value: apiUrl };
  const alarms = new FakeAlarms();
  const backend = mockBackend(account);
  const auth = new AuthClient(backend.fetch, () => environment.value);
  const store = new SessionStore(storage);
  const hooks = new SessionHooks();
  let manager: SessionManager;
  const autoLock = new AutoLock(alarms, () => { void manager.lock(); });
  manager = new SessionManager({ store, authClient: auth, autoLock, hooks, ...(onOwnActivity ? { onOwnActivity } : {}), ...(onOwnPolicyChanged ? { onOwnPolicyChanged } : {}), ...(retireSharedUnlock ? { retireSharedUnlock } : {}), now: () => now.value });
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

it.each(["future", "too-old", "before-install", "at-install", "repeated", "out-of-order"] as const)("rejects %s popup input instead of renewing a session", async kind => {
  const h = harness(), value = fresh();
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  const installedAt = h.now.value;
  h.now.value += kind === "too-old" ? 10_000 : 1_000;
  let at = h.now.value;
  if (kind === "future") at += 1;
  if (kind === "too-old") at -= 5_001;
  if (kind === "before-install") at = installedAt - 1;
  if (kind === "at-install") at = installedAt;
  if (kind === "repeated" || kind === "out-of-order") {
    await h.manager.touchActivity(at);
    if (kind === "out-of-order") at -= 1;
  }
  const before = h.manager.getSharedUnlockLimits();
  const alarm = h.alarms.whenFor(AUTO_LOCK_ALARM);
  await h.manager.touchActivity(at);
  expect(h.manager.getSharedUnlockLimits()).toEqual(before);
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(alarm);
  await h.manager.lock();
});
it("uses observed popup time rather than delayed worker handling time and preserves original ceilings", async () => {
  const h = harness(), value = fresh();
  await h.manager.setAutoLockPolicy("15m");
  const limits = { ...value.limits, idleDeadlineMs: h.now.value + 50_000,
    absoluteDeadlineMs: h.now.value + 5_000_000, offlineDeadlineMs: h.now.value + 4_000_000 };
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install({ ...value, limits });
  const observedAt = h.now.value + 100;
  h.now.value = observedAt + 2_000;
  await h.manager.touchActivity(observedAt);
  expect(h.manager.getSharedUnlockLimits()).toEqual({ ...limits, idleDeadlineMs: observedAt + 15 * 60_000 });
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(observedAt + 15 * 60_000);
  await h.manager.lock();
});

it("does not let a delayed older input overwrite a newer activity deadline", async () => {
  const h = harness(), value = fresh();
  await h.manager.setAutoLockPolicy("15m");
  const limits = { ...value.limits, idleDeadlineMs: h.now.value + 50_000,
    absoluteDeadlineMs: h.now.value + 5_000_000, offlineDeadlineMs: h.now.value + 4_000_000 };
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install({ ...value, limits });
  let release!: () => void;
  const original = h.store.getAutoLock.bind(h.store);
  vi.spyOn(h.store, "getAutoLock").mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return original();
  });
  h.now.value += 100;
  const older = h.manager.touchActivity(h.now.value);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  h.now.value += 100;
  await h.manager.touchActivity(h.now.value);
  const latestDeadline = h.now.value + 15 * 60_000;
  release(); await older;
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(latestDeadline);
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(latestDeadline);
  await h.manager.lock();
});

it("connects admitted real SessionManager input to only its own Identity root and durable checkpoint", async () => {
  const values: Record<string, unknown> = {};
  const h = harness(new FakeStorageArea(), undefined, () => recordExtensionOwnActivity(h.manager, authority, recorder));
  const now = vi.spyOn(Date, "now").mockImplementation(() => h.now.value);
  const value = fresh();
  const root = { ...sharedUnlockFixtures.operations[0].sourceAuthorization, ...value.limits, accountId: account.accountId };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(apiUrl + "/api/account/shared-unlock/authorizations/activity");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer receiver-own-access");
    const input = JSON.parse(String(init?.body));
    expect(input.refreshToken).toBe("receiver-own-refresh");
    return new Response(JSON.stringify({ ...root, idleDeadlineMs: input.idleDeadlineMs }));
  });
  const api = new SharedUnlockApi(fetcher, () => apiUrl);
  const authority = new SharedUnlockSourceAuthority(api, () => h.now.value);
  const expiry = new SharedUnlockExpiryStore({ get: async () => values, set: async items => { Object.assign(values, items); } }, action => action(), () => h.now.value);
  const recorder = new OwnSharedUnlockActivityRecorder(api, expiry);
  try {
    await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
    authority.adopt(root, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => { if (!h.manager.getKeys()) throw new Error("own keys locked"); });
    await expiry.checkpoint({ apiUrl, accountId: account.accountId }, root.sequence, value.limits.idleDeadlineMs, value.limits.offlineDeadlineMs);
    h.now.value += 100;
    await h.manager.touchActivity(h.now.value);
    await vi.waitFor(() => expect(authority.snapshot().authorization?.idleDeadlineMs).toBe(value.limits.offlineDeadlineMs));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(h.manager.getSharedUnlockLimits()?.absoluteDeadlineMs).toBe(value.limits.absoluteDeadlineMs);
    expect(await expiry.checkpoint({ apiUrl, accountId: account.accountId }, root.sequence, value.limits.absoluteDeadlineMs, value.limits.offlineDeadlineMs)).toBe(value.limits.offlineDeadlineMs);
  } finally { await h.manager.lock(); authority.reset(); now.mockRestore(); }
});


it("persists a shorter live policy before reopening and never treats settings as activity", async () => {
  let changed!: () => Promise<void>;
  const activity = vi.fn();
  const h = harness(undefined, undefined, activity, () => changed());
  const value = { ...fresh() };
  value.limits = { unlockedAtMs: h.now.value, idleDeadlineMs: h.now.value + 4 * 3_600_000,
    absoluteDeadlineMs: h.now.value + 8 * 3_600_000, offlineDeadlineMs: h.now.value + 6 * 3_600_000 };
  const root = { ...sharedUnlockFixtures.operations[0].sourceAuthorization, ...value.limits, accountId: account.accountId };
  const authority = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => apiUrl), () => h.now.value);
  const storage = new FakeStorageArea(), expiry = new SharedUnlockExpiryStore(storage, action => action(), () => h.now.value);
  const scope = { apiUrl, accountId: account.accountId };
  changed = () => recordExtensionOwnPolicy(h.manager, authority, expiry);
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  authority.adopt(root, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => { if (!h.manager.getKeys()) throw new Error("locked"); });
  await expiry.checkpoint(scope, root.sequence, root.idleDeadlineMs, root.offlineDeadlineMs);
  const source = h.manager.captureSharedUnlockSource();
  h.now.value += 60_000;
  await h.manager.setAutoLockPolicy("15m");
  const deadline = value.limits.unlockedAtMs + 15 * 60_000;
  expect(source.signal.aborted).toBe(true);
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(deadline);
  expect(authority.snapshot().authorization?.idleDeadlineMs).toBe(deadline);
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBe(deadline);
  expect(activity).not.toHaveBeenCalled();
  await h.manager.setAutoLockPolicy("on-close");
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(deadline);
  expect(activity).not.toHaveBeenCalled();
  h.now.value = deadline;
  const restarted = new SharedUnlockExpiryStore(storage, action => action(), () => h.now.value);
  await expect(restarted.checkpoint(scope, root.sequence, root.idleDeadlineMs, root.offlineDeadlineMs)).rejects.toThrow();
  expect(h.manager.getKeys()).toBeNull();
  erased(value);
});

it("does not let a stale input policy read undo a newly selected shorter policy", async () => {
  const h = harness(), value = { ...fresh() };
  value.limits = { ...value.limits, idleDeadlineMs: h.now.value + 14_400_000,
    absoluteDeadlineMs: h.now.value + 28_800_000, offlineDeadlineMs: h.now.value + 21_600_000 };
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  let release!: () => void;
  const original = h.store.getAutoLock.bind(h.store);
  vi.spyOn(h.store, "getAutoLock").mockImplementationOnce(async () => {
    const old = await original(); await new Promise<void>(resolve => { release = resolve; }); return old;
  });
  h.now.value += 100;
  const input = h.manager.touchActivity(h.now.value);
  await vi.waitFor(() => expect(release).toBeDefined());
  await h.manager.setAutoLockPolicy("15m");
  const deadline = h.manager.getSharedUnlockLimits()!.idleDeadlineMs;
  release(); await input;
  expect(await h.manager.getAutoLockPolicy()).toBe("15m");
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(deadline);
  await h.manager.lock();
});

it("applies tighter key-use limits during a stalled policy write and does not rearm after lock", async () => {
  const h = harness(), value = { ...fresh() };
  value.limits = { ...value.limits, idleDeadlineMs: h.now.value + 14_400_000,
    absoluteDeadlineMs: h.now.value + 28_800_000, offlineDeadlineMs: h.now.value + 21_600_000 };
  await (await h.manager.beginSharedUnlockInstall(account.accountId, apiUrl, () => {})).install(value);
  let release!: () => void;
  const original = h.store.setAutoLock.bind(h.store);
  vi.spyOn(h.store, "setAutoLock").mockImplementationOnce(async record => {
    await new Promise<void>(resolve => { release = resolve; }); await original(record);
  });
  const change = h.manager.setAutoLockPolicy("15m");
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(h.now.value + 900_000);
  h.now.value += 900_000;
  expect(h.manager.getKeys()).toBeNull(); erased(value);
  release(); await change;
  expect(h.alarms.whenFor(AUTO_LOCK_ALARM)).toBeUndefined();
});
