import { beforeAll, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@palladin/crypto";
import { AutoLock } from "./auto-lock";
import { AuthClient } from "./auth-client";
import { SessionManager, type SessionManagerDeps } from "./session-manager";
import { SessionStore } from "./session-store";
import { buildTestAccount, FakeAlarms, FakeStorageArea, mockBackend, type TestAccount, type MockBackendOptions } from "./test-support";
import type { ManualUnlockContext, PrepareManualUnlock } from "./manual-unlock";

let account: TestAccount;
beforeAll(async () => { account = await buildTestAccount(); });
function harness(prepare: PrepareManualUnlock, options: MockBackendOptions = {}, pendingTotpTimers?: SessionManagerDeps["pendingTotpTimers"]) {
  const storage = new FakeStorageArea(); const store = new SessionStore(storage);
  const backend = mockBackend(account, options);
  const fetch = vi.fn(backend.fetch);
  const auth = new AuthClient(fetch, "https://api.test");
  const manager = new SessionManager({ store, authClient: auth, autoLock: new AutoLock(new FakeAlarms(), () => {}),
    prepareManualUnlock: prepare, now: () => 1_000_000, ...(pendingTotpTimers ? { pendingTotpTimers } : {}) });
  return { manager, auth, storage, fetch, backend };
}

describe("fresh manual password proof boundary", () => {
  it("refreshes an expired restored access token before preparing shared unlock without publishing keys early", async () => {
    const prepare: PrepareManualUnlock = async context => {
      expect(h.manager.getKeys()).toBeNull();
      expect(toBase64Url(context.authCredential)).toBe(account.expectedAuthCredential);
      context.assertCurrent();
      return context.limits;
    };
    const h = harness(prepare);
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    h.manager = new SessionManager({ store: new SessionStore(h.storage), authClient: h.auth,
      autoLock: new AutoLock(new FakeAlarms(), () => {}), now: () => 1_000_000,
      prepareManualUnlock: prepare });
    await h.manager.initialize();
    let rotations = 0;
    h.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        rotations++;
        expect(h.manager.getKeys()).toBeNull();
        return Response.json({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2' });
      }
      if (url.endsWith('/api/account') && new Headers(init?.headers).get('authorization') !== 'Bearer access-token-2') {
        return new Response(null, { status: 401 });
      }
      return h.backend.fetch(input, init);
    });

    await h.manager.unlockWithPassword(account.password);

    expect(h.manager.getSharedUnlockLimits()).not.toBeNull();
    expect(rotations).toBe(1);
    const source = h.manager.captureSharedUnlockSource();
    expect(source.read().tokens.accessToken).toBe('access-token-2');
    source.dispose();
    expect(JSON.stringify(h.storage.values())).not.toContain('refresh-token-2');
    await h.manager.lock();
    const restarted = new SessionManager({ store: new SessionStore(h.storage), authClient: h.auth,
      autoLock: new AutoLock(new FakeAlarms(), () => {}), now: () => 1_000_000,
      prepareManualUnlock: async context => context.limits });
    await restarted.initialize();
    await restarted.unlockWithPassword(account.password);
    expect(restarted.getSharedUnlockLimits()).not.toBeNull();
    expect(rotations).toBe(1);
    await restarted.logout();
  });

  it.each(['lock', 'logout'] as const)('does not publish an unlock when %s interrupts its token refresh', async action => {
    const h = harness(async context => context.limits);
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    let entered!: () => void, release!: (response: Response) => void;
    const refreshing = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<Response>(resolve => { release = resolve; });
    h.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/account')) return new Response(null, { status: 401 });
      if (String(input).endsWith('/api/auth/refresh')) { entered(); return response; }
      return h.backend.fetch(input, init);
    });
    const unlocking = h.manager.unlockWithPassword(account.password);
    const rejected = expect(unlocking).rejects.toThrow();
    await refreshing;
    try {
      expect(h.manager.getKeys()).toBeNull();
      await h.manager[action]();
    } finally { release(Response.json({ accessToken: 'stale-access', refreshToken: 'stale-refresh' })); }
    await rejected;
    expect(h.manager.getKeys()).toBeNull();
    expect(h.manager.getSharedUnlockLimits()).toBeNull();
    expect(await h.manager.getStatus()).toBe(action === 'lock' ? 'locked' : 'signed-out');
    if (action === 'lock') {
      await expect(h.manager.unlockWithPassword(account.password)).rejects.toMatchObject({ code: 'not-authenticated' });
      expect(h.manager.getKeys()).toBeNull();
    }
  });

  it.each([401, 503])('handles refresh rejection %s without manufacturing shared-unlock authority', async status => {
    const h = harness(async context => context.limits);
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    let rotations = 0;
    h.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/account')) return new Response(null, { status: 401 });
      if (String(input).endsWith('/api/auth/refresh')) { rotations++; return new Response(null, { status }); }
      return h.backend.fetch(input, init);
    });
    const unlocking = h.manager.unlockWithPassword(account.password);
    if (status === 401) {
      await expect(unlocking).rejects.toThrow();
      expect(await h.manager.getStatus()).toBe('signed-out');
      expect(h.manager.getKeys()).toBeNull();
    } else {
      await unlocking;
      expect(await h.manager.getStatus()).toBe('unlocked');
    }
    expect(rotations).toBe(1);
    expect(h.manager.getSharedUnlockLimits()).toBeNull();
    await h.manager.logout();
  });

  it('does not loop when account access is still rejected after refresh', async () => {
    const h = harness(async context => context.limits);
    await h.manager.login(account.email, account.password);
    await h.manager.lock();
    let rotations = 0, accountReads = 0;
    h.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/account')) { accountReads++; return new Response(null, { status: 401 }); }
      if (String(input).endsWith('/api/auth/refresh')) rotations++;
      return h.backend.fetch(input, init);
    });
    await h.manager.unlockWithPassword(account.password);
    expect(await h.manager.getStatus()).toBe('unlocked');
    expect(h.manager.getSharedUnlockLimits()).toBeNull();
    expect(rotations).toBe(1);
    expect(accountReads).toBe(2);
    await h.manager.logout();
  });

  it('restores and unlocks the durable own session on an explicitly approved remote HTTP API', async () => {
    const apiUrl = 'http://vault.example.test:8080/api';
    const storage = new FakeStorageArea();
    const store = new SessionStore(storage, undefined, () => ({ allowHttpApiUrls: [apiUrl] }));
    const make = () => new SessionManager({ store, now: () => 1_000_000,
      authClient: new AuthClient(mockBackend(account).fetch, apiUrl),
      autoLock: new AutoLock(new FakeAlarms(), () => {}) });
    const first = make();
    await first.login(account.email, account.password);
    expect(await first.getStatus()).toBe('unlocked');
    await first.lock();
    const restarted = make();
    expect(await restarted.initialize()).toBe('locked');
    await restarted.unlockWithPassword(account.password);
    expect(await restarted.getStatus()).toBe('unlocked');
    expect(restarted.getKeys()).not.toBeNull();
    await restarted.logout();
  });

  it("prepares before publishing keys and wipes borrowed proof after login and password unlock", async () => {
    const captured: ManualUnlockContext[] = [];
    const prepare = vi.fn<PrepareManualUnlock>().mockImplementation(async context => {
      expect(h.manager.getKeys()).toBeNull();
      expect(toBase64Url(context.authCredential)).toBe(account.expectedAuthCredential);
      captured.push(context); return context.limits;
    });
    const h = harness(prepare);
    await h.manager.login(account.email, account.password);
    expect(await h.manager.getStatus()).toBe("unlocked");
    expect(captured[0].authCredential).toEqual(new Uint8Array(32));
    await h.manager.lock();
    await h.manager.unlockWithPassword(account.password);
    expect(captured[1].authCredential).toEqual(new Uint8Array(32));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.storage.values())).not.toContain(account.expectedAuthCredential);
  });

  it("prepares only after TOTP completes and clears its retained password proof", async () => {
    let borrowed: Uint8Array | null = null;
    const prepare = vi.fn<PrepareManualUnlock>().mockImplementation(async context => {
      expect(toBase64Url(context.authCredential)).toBe(account.expectedAuthCredential);
      borrowed = context.authCredential; return context.limits;
    });
    const h = harness(prepare, { totpRequired: true });
    await h.manager.login(account.email, account.password);
    expect(prepare).not.toHaveBeenCalled();
    await h.manager.completeTotp("challenge-1", "123456");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(borrowed).toEqual(new Uint8Array(32));
    expect(await h.manager.getStatus()).toBe("unlocked");
  });

  for (const action of ["cancel", "timeout", "lock", "logout"] as const) {
    it(`erases the pending TOTP proof on ${action}`, async () => {
      let expire!: () => void;
      const prepare = vi.fn<PrepareManualUnlock>();
      const h = harness(prepare, { totpRequired: true }, { schedule: callback => { expire = callback; return 1; }, cancel: () => {} });
      await h.manager.login(account.email, account.password);
      const pending = (h.manager as unknown as { pendingTotp: { authCredential: Uint8Array } }).pendingTotp;
      expect(toBase64Url(pending.authCredential)).toBe(account.expectedAuthCredential);
      if (action === "cancel") h.manager.cancelTotp();
      if (action === "timeout") expire();
      if (action === "lock") await h.manager.lock();
      if (action === "logout") await h.manager.logout();
      expect(pending.authCredential).toEqual(new Uint8Array(32));
      expect(prepare).not.toHaveBeenCalled();
      expect(h.manager.getKeys()).toBeNull();
    });
  }

  it("preserves own unlock when sharing preparation fails", async () => {
    const prepare = vi.fn<PrepareManualUnlock>().mockRejectedValue(new Error("sharing unavailable"));
    const h = harness(prepare);
    await h.manager.login(account.email, account.password);
    expect(await h.manager.getStatus()).toBe("unlocked");
    await h.manager.lock();
    await h.manager.unlockWithPassword(account.password);
    expect(await h.manager.getStatus()).toBe("unlocked");
    expect(h.manager.getSharedUnlockLimits()).toBeNull();
  });

  it("does not prepare with an incorrect password", async () => {
    const prepare = vi.fn<PrepareManualUnlock>(); const h = harness(prepare);
    await expect(h.manager.login(account.email, "incorrect")).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });

  for (const method of ["login", "unlock"] as const) {
    it(`wipes the proof immediately when lock cancels ${method} during preparation`, async () => {
      let release!: () => void;
      let proof: Uint8Array | null = null;
      let entered!: () => void;
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const prepare = vi.fn<PrepareManualUnlock>().mockImplementation(async context => {
        proof = context.authCredential; entered(); await pending; context.assertCurrent(); return context.limits;
      });
      const h = harness(prepare);
      if (method === "unlock") {
        prepare.mockResolvedValueOnce(null);
        await h.manager.login(account.email, account.password); await h.manager.lock();
      }
      const operation = method === "login" ? h.manager.login(account.email, account.password)
        : h.manager.unlockWithPassword(account.password);
      const rejected = expect(operation).rejects.toThrow();
      await preparing;
      expect(proof).not.toBeNull();
      await h.manager.lock();
      expect(proof).toEqual(new Uint8Array(32));
      release(); await rejected;
      expect(h.manager.getKeys()).toBeNull();
    });
  }
});

it("persists the final shorter policy before keys on both own login and password unlock", async () => {
  const checkpoint = vi.fn(async (deadline: number) => {
    expect(deadline).toBe(1_000_000 + 15 * 60_000);
    expect(h.manager.getKeys()).toBeNull();
    return 1_000_500;
  });
  const prepare = vi.fn<PrepareManualUnlock>().mockImplementation(async context => {
    await h.manager.setAutoLockPolicy("15m");
    return { ...context.limits, checkpoint };
  });
  const h = harness(prepare);
  await h.manager.login(account.email, account.password);
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(1_000_500);
  await h.manager.lock();
  await h.manager.unlockWithPassword(account.password);
  expect(h.manager.getSharedUnlockLimits()?.idleDeadlineMs).toBe(1_000_500);
  expect(checkpoint).toHaveBeenCalledTimes(2);
  expect(Object.keys(h.manager.getSharedUnlockLimits()!)).not.toContain("checkpoint");
});

it.each(['account read', 'sharing preparation'] as const)(
  'keeps TOTP completion exclusive through %s', async boundary => {
    let release!: () => void, entered!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const prepare = vi.fn<PrepareManualUnlock>().mockImplementation(async context => {
      if (boundary === 'sharing preparation') { entered(); await stalled; }
      context.assertCurrent(); return context.limits;
    });
    const h = harness(prepare, { totpRequired: true });
    if (boundary === 'account read') {
      const getAccount = h.auth.getAccount.bind(h.auth);
      vi.spyOn(h.auth, 'getAccount').mockImplementation(async (...args) => {
        entered(); await stalled; return getAccount(...args);
      });
    }
    await h.manager.login(account.email, account.password);
    const completing = h.manager.completeTotp('challenge-1', '123456');
    await reached;
    try {
      expect(h.manager.getKeys()).toBeNull();
      await expect(h.manager.beginSharedUnlockInstall(account.accountId, 'https://api.test', () => {})).rejects.toThrow();
      await expect(h.manager.beginSharedUnlockInstall('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'https://api.test', () => {})).rejects.toThrow();
      await expect(h.manager.login(account.email, account.password)).rejects.toThrow('already in progress');
      await expect(h.manager.completeTotp('challenge-1', '123456')).rejects.toThrow('already in progress');
    } finally { release(); await completing; }
    expect(await h.manager.getStatus()).toBe('unlocked');
    await h.manager.logout();
  },
);
