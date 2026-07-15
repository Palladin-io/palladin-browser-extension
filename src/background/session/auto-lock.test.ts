import { beforeEach, describe, expect, it } from "vitest";

import { AuthClient } from "./auth-client";
import {
  AutoLock,
  AUTO_LOCK_ALARM,
  DEFAULT_AUTO_LOCK_POLICY,
  isAutoLockPolicy,
  policyIdleMs,
} from "./auto-lock";
import { SessionManager } from "./session-manager";
import { SessionStore } from "./session-store";
import {
  buildTestAccount,
  FakeAlarms,
  FakeStorageArea,
  mockBackend,
  type TestAccount,
} from "./test-support";

describe("auto-lock policy math", () => {
  it("maps idle policies to milliseconds and on-close to null", () => {
    expect(policyIdleMs("15m")).toBe(15 * 60_000);
    expect(policyIdleMs("1h")).toBe(60 * 60_000);
    expect(policyIdleMs("4h")).toBe(4 * 60 * 60_000);
    expect(policyIdleMs("on-close")).toBeNull();
  });

  it("defaults to 4h", () => {
    expect(DEFAULT_AUTO_LOCK_POLICY).toBe("4h");
  });

  it("validates policy strings", () => {
    expect(isAutoLockPolicy("1h")).toBe(true);
    expect(isAutoLockPolicy("2d")).toBe(false);
    expect(isAutoLockPolicy(30)).toBe(false);
  });
});

describe("AutoLock scheduling", () => {
  it("arms an idle alarm at lastActivity + idle window", () => {
    const alarms = new FakeAlarms();
    const lock = new AutoLock(alarms, () => {});
    lock.arm("15m", 1_000);
    expect(alarms.whenFor(AUTO_LOCK_ALARM)).toBe(1_000 + 15 * 60_000);
  });

  it("schedules no alarm for on-close (storage.session dies with the browser)", async () => {
    const alarms = new FakeAlarms();
    const lock = new AutoLock(alarms, () => {});
    lock.arm("15m", 0);
    lock.arm("on-close", 0);
    expect(alarms.created.has(AUTO_LOCK_ALARM)).toBe(false);
  });

  it("fires only for its own alarm name", () => {
    const alarms = new FakeAlarms();
    let fired = 0;
    const lock = new AutoLock(alarms, () => {
      fired += 1;
    });
    lock.dispatch("palladin.sync");
    expect(fired).toBe(0);
    lock.dispatch(AUTO_LOCK_ALARM);
    expect(fired).toBe(1);
  });
});

describe("AutoLock integration with the manager", () => {
  let account: TestAccount;
  beforeEach(async () => {
    account = await buildTestAccount();
  });

  function harness() {
    const storage = new FakeStorageArea();
    const alarms = new FakeAlarms();
    const now = { value: 0 };
    const authClient = new AuthClient(mockBackend(account).fetch, "http://api.test");
    const pending: Promise<void>[] = [];
    let mgr: SessionManager;
    const autoLock = new AutoLock(alarms, () => pending.push(mgr.lock()));
    alarms.onFire((name) => autoLock.dispatch(name));
    mgr = new SessionManager({
      store: new SessionStore(storage),
      authClient,
      autoLock,
      now: () => now.value,
    });
    // `settle` awaits any lock kicked off by a fired alarm.
    return { mgr, alarms, now, settle: () => Promise.all(pending) };
  }

  it("locks and wipes keys when the idle alarm fires", async () => {
    const { mgr, alarms, settle } = harness();
    await mgr.login(account.email, account.password);
    expect(await mgr.getStatus()).toBe("unlocked");

    // The browser fires the idle alarm after the window elapses.
    alarms.fire(AUTO_LOCK_ALARM);
    await settle();

    expect(await mgr.getStatus()).toBe("locked");
    expect(mgr.getKeys()).toBeNull();
  });

  it("pushes the idle deadline out on activity", async () => {
    const { mgr, alarms, now } = harness();
    await mgr.login(account.email, account.password);
    const armedAt = alarms.whenFor(AUTO_LOCK_ALARM);

    now.value = 30 * 60_000; // 30 minutes of activity later
    await mgr.touchActivity();

    const rearmedAt = alarms.whenFor(AUTO_LOCK_ALARM);
    expect(rearmedAt).toBeGreaterThan(armedAt!);
    expect(rearmedAt).toBe(now.value + policyIdleMs(DEFAULT_AUTO_LOCK_POLICY)!);
  });

  it("re-arms immediately when the policy changes", async () => {
    const { mgr, alarms, now } = harness();
    await mgr.login(account.email, account.password);

    await mgr.setAutoLockPolicy("15m");
    expect(await mgr.getAutoLockPolicy()).toBe("15m");
    expect(alarms.whenFor(AUTO_LOCK_ALARM)).toBe(now.value + policyIdleMs("15m")!);
  });
});
