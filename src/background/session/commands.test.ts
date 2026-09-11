import { describe, expect, it, vi } from "vitest";

import { AuthClient } from "./auth-client";
import { AutoLock } from "./auto-lock";
import { dispatchSessionCommand, handleRuntimeMessage } from "./commands";
import { SessionManager, type SessionManagerDeps } from "./session-manager";
import { SessionStore } from "./session-store";
import {
  buildTestAccount,
  FakeAlarms,
  FakeStorageArea,
  mockBackend,
  type TestAccount,
} from "./test-support";

async function makeManager(account: TestAccount, recordManualClosing?: SessionManagerDeps["recordManualClosing"]): Promise<SessionManager> {
  const storage = new FakeStorageArea();
  const alarms = new FakeAlarms();
  const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
  let mgr: SessionManager;
  const autoLock = new AutoLock(alarms, () => void mgr.lock());
  mgr = new SessionManager({ store: new SessionStore(storage), authClient, autoLock, ...(recordManualClosing ? { recordManualClosing } : {}) });
  return mgr;
}

describe("dispatchSessionCommand", () => {
  it(
    "drives the full login → lock → unlock → logout cycle",
    async () => {
      const account = await buildTestAccount();
      const mgr = await makeManager(account);

      const login = await dispatchSessionCommand(mgr, {
        type: "session/login",
        email: account.email,
        password: account.password,
      });
      expect(login).toEqual({ ok: true, login: { status: "unlocked" } });

      expect(await dispatchSessionCommand(mgr, { type: "session/status" })).toEqual({
        ok: true,
        status: "unlocked",
      });

      expect(await dispatchSessionCommand(mgr, { type: "session/lock" })).toEqual({
        ok: true,
        status: "locked",
      });

      expect(
        await dispatchSessionCommand(mgr, { type: "session/unlock", password: account.password }),
      ).toEqual({ ok: true, status: "unlocked" });

      expect(await dispatchSessionCommand(mgr, { type: "session/logout" })).toEqual({
        ok: true,
        status: "signed-out",
      });
    },
    15_000,
  );

  it("returns a typed failure for a wrong password", async () => {
    const account = await buildTestAccount();
    const mgr = await makeManager(account);
    const result = await dispatchSessionCommand(mgr, {
      type: "session/login",
      email: account.email,
      password: "wrong",
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid-credentials",
      message: expect.any(String),
    });
  });

  it("reports session capabilities (runtime unlock unavailable today)", async () => {
    const account = await buildTestAccount();
    const mgr = await makeManager(account);
    expect(await dispatchSessionCommand(mgr, { type: "session/capabilities" })).toEqual({
      ok: true,
      capabilities: { runtimeUnlock: false },
    });
  });

  it("reads and sets the auto-lock policy, rejecting an unknown value", async () => {
    const account = await buildTestAccount();
    const mgr = await makeManager(account);
    await dispatchSessionCommand(mgr, {
      type: "session/login",
      email: account.email,
      password: account.password,
    });

    expect(await dispatchSessionCommand(mgr, { type: "session/getAutoLock" })).toEqual({
      ok: true,
      policy: "4h",
    });
    expect(
      await dispatchSessionCommand(mgr, { type: "session/setAutoLock", policy: "15m" }),
    ).toEqual({ ok: true, policy: "15m" });
    expect(
      // @ts-expect-error — exercising the runtime guard against an invalid policy
      await dispatchSessionCommand(mgr, { type: "session/setAutoLock", policy: "bogus" }),
    ).toEqual({ ok: false, code: "invalid-credentials", message: expect.any(String) });
  }, 15_000);

  it("cancels a pending TOTP challenge in the background", async () => {
    const account = await buildTestAccount();
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    const backend = mockBackend(account, { totpRequired: true, totpCode: "424242" });
    let mgr: SessionManager;
    const autoLock = new AutoLock(alarms, () => void mgr.lock());
    mgr = new SessionManager({
      store: new SessionStore(storage),
      authClient: new AuthClient(backend.fetch, "https://api.test"),
      autoLock,
    });
    await dispatchSessionCommand(mgr, {
      type: "session/login",
      email: account.email,
      password: account.password,
    });

    expect(await dispatchSessionCommand(mgr, { type: "session/cancelTotp" }))
      .toEqual({ ok: true });
    expect(await dispatchSessionCommand(mgr, {
      type: "session/completeTotp",
      challengeToken: "challenge-1",
      code: "424242",
    })).toMatchObject({ ok: false, code: "network" });
  }, 15_000);
});

describe("handleRuntimeMessage", () => {
  it("ignores non-session messages", async () => {
    const account = await buildTestAccount();
    const mgr = await makeManager(account);
    expect(await handleRuntimeMessage(mgr, { type: "other/thing" })).toBeNull();
    expect(await handleRuntimeMessage(mgr, "not-an-object")).toBeNull();
  });

  it("handles a recognised session command", async () => {
    const account = await buildTestAccount();
    const mgr = await makeManager(account);
    const result = await handleRuntimeMessage(mgr, { type: "session/status" });
    expect(result).toEqual({ ok: true, status: "signed-out" });
  });
});


describe("manual closing command boundary", () => {
  it("keeps internal lock local and records explicit lock even when already locked", async () => {
    const account = await buildTestAccount(), record = vi.fn(async () => {});
    const manager = await makeManager(account, record);
    await manager.login(account.email, account.password);
    await manager.lock(); expect(record).not.toHaveBeenCalled();
    expect(await dispatchSessionCommand(manager, { type: "session/lock" })).toMatchObject({ ok: true });
    expect(record).toHaveBeenCalledWith(account.accountId, "lock");
    await manager.logout(); expect(record).toHaveBeenCalledTimes(1);
  });
  it("wipes keys before awaiting a durable manual lock and does not report success early", async () => {
    const account = await buildTestAccount(); let finish!: () => void;
    const record = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const manager = await makeManager(account, record); await manager.login(account.email, account.password);
    const keys = manager.getKeys()!; let completed = false;
    const result = dispatchSessionCommand(manager, { type: "session/lock" }).then(value => { completed = true; return value; });
    expect(manager.getKeys()).toBeNull(); expect(keys.masterKey.every(byte => byte === 0)).toBe(true);
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce()); expect(completed).toBe(false);
    finish(); expect(await result).toMatchObject({ ok: true, status: "locked" }); await manager.logout();
  });
  it("finishes local logout when saving shared closing fails and reports the failure", async () => {
    const account = await buildTestAccount(), record = vi.fn(async () => { throw new Error("disk"); });
    const manager = await makeManager(account, record); await manager.login(account.email, account.password);
    const keys = manager.getKeys()!;
    expect(await dispatchSessionCommand(manager, { type: "session/logout" })).toMatchObject({ ok: false, code: "network" });
    expect(record).toHaveBeenCalledWith(account.accountId, "logout");
    expect(keys.masterKey.every(byte => byte === 0)).toBe(true);
    expect(await manager.getStatus()).toBe("signed-out"); expect(await manager.getAccessToken()).toBeNull();
  });
});
