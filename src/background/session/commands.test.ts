import { describe, expect, it } from "vitest";

import { AuthClient } from "./auth-client";
import { AutoLock } from "./auto-lock";
import { dispatchSessionCommand, handleRuntimeMessage } from "./commands";
import { SessionManager } from "./session-manager";
import { SessionStore } from "./session-store";
import {
  buildTestAccount,
  FakeAlarms,
  FakeStorageArea,
  mockBackend,
  type TestAccount,
} from "./test-support";

async function makeManager(account: TestAccount): Promise<SessionManager> {
  const storage = new FakeStorageArea();
  const alarms = new FakeAlarms();
  const authClient = new AuthClient(mockBackend(account).fetch, "https://api.test");
  let mgr: SessionManager;
  const autoLock = new AutoLock(alarms, () => void mgr.lock());
  mgr = new SessionManager({ store: new SessionStore(storage), authClient, autoLock });
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
