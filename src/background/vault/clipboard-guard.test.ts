import { describe, expect, it, vi } from "vitest";

import { FakeAlarms } from "../session/test-support";
import {
  CLIPBOARD_CLEAR_ALARM,
  CLIPBOARD_TTL_MS,
  ClipboardGuard,
} from "./clipboard-guard";

describe("ClipboardGuard", () => {
  it("schedules the wipe ttl from now on arm", () => {
    const alarms = new FakeAlarms();
    const guard = new ClipboardGuard({ alarms, clear: vi.fn(), now: () => 1_000 });

    guard.arm();
    expect(alarms.whenFor(CLIPBOARD_CLEAR_ALARM)).toBe(1_000 + CLIPBOARD_TTL_MS);
  });

  it("re-arming reschedules to the later deadline (last copy wins)", () => {
    const alarms = new FakeAlarms();
    let now = 0;
    const guard = new ClipboardGuard({ alarms, clear: vi.fn(), ttlMs: 100, now: () => now });

    guard.arm();
    now = 500;
    guard.arm();
    expect(alarms.whenFor(CLIPBOARD_CLEAR_ALARM)).toBe(600);
  });

  it("clears only when the clipboard alarm fires", async () => {
    const alarms = new FakeAlarms();
    const clear = vi.fn(() => Promise.resolve());
    const guard = new ClipboardGuard({ alarms, clear });

    await guard.handleAlarm("palladin.autolock");
    expect(clear).not.toHaveBeenCalled();

    await guard.handleAlarm(CLIPBOARD_CLEAR_ALARM);
    expect(clear).toHaveBeenCalledOnce();
  });
});
