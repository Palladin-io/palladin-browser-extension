import { describe, expect, it } from "vitest";

import {
  NoopPushRegistration,
  NoopSyncTrigger,
  SessionHooks,
} from "./hooks";

describe("SessionHooks", () => {
  it("dispatches unlocked and locked events to subscribers", () => {
    const hooks = new SessionHooks();
    const seen: string[] = [];
    hooks.onUnlocked((e) => seen.push(`u:${e.userId}`));
    hooks.onLocked((e) => seen.push(`l:${e.userId}`));

    hooks.emitUnlocked({ userId: "x" });
    hooks.emitLocked({ userId: "x" });

    expect(seen).toEqual(["u:x", "l:x"]);
  });

  it("stops delivering after unsubscribe", () => {
    const hooks = new SessionHooks();
    let count = 0;
    const off = hooks.onUnlocked(() => (count += 1));
    hooks.emitUnlocked({ userId: "a" });
    off();
    hooks.emitUnlocked({ userId: "a" });
    expect(count).toBe(1);
  });
});

describe("Noop hook implementations", () => {
  it("are inert stubs for the sync and push slots", async () => {
    expect(() => new NoopSyncTrigger().requestSync("unlocked")).not.toThrow();
    await expect(new NoopPushRegistration().register("u")).resolves.toBeUndefined();
    await expect(new NoopPushRegistration().unregister("u")).resolves.toBeUndefined();
  });
});
