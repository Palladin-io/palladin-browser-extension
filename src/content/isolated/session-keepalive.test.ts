import { describe, expect, it, vi } from "vitest";

import {
  createSessionKeepalive,
  SESSION_KEEPALIVE_INTERVAL_MS,
  type SessionKeepaliveTimers,
} from "./session-keepalive";

describe("unlocked session keepalive", () => {
  it("pings only while worker-owned liveness is enabled", () => {
    let callback: (() => void) | null = null;
    const timers: SessionKeepaliveTimers = {
      setInterval: vi.fn((next, intervalMs) => {
        expect(intervalMs).toBe(SESSION_KEEPALIVE_INTERVAL_MS);
        callback = next;
        return 7;
      }),
      clearInterval: vi.fn(),
    };
    const send = vi.fn();
    const keepalive = createSessionKeepalive(send, timers);

    keepalive.setEnabled(true);
    expect(send).not.toHaveBeenCalled();
    if (callback === null) throw new Error("timer was not scheduled");
    (callback as () => void)();
    expect(send).toHaveBeenCalledWith({
      channel: "palladin.session/liveness",
      type: "ping",
    });

    keepalive.setEnabled(false);
    expect(timers.clearInterval).toHaveBeenCalledWith(7);
  });

  it("replaces an existing timer and stops on document suspension", () => {
    let nextHandle = 1;
    const timers: SessionKeepaliveTimers = {
      setInterval: vi.fn(() => nextHandle++),
      clearInterval: vi.fn(),
    };
    const keepalive = createSessionKeepalive(vi.fn(), timers);

    keepalive.setEnabled(true);
    keepalive.setEnabled(true);
    keepalive.stop();

    expect(timers.clearInterval).toHaveBeenNthCalledWith(1, 1);
    expect(timers.clearInterval).toHaveBeenNthCalledWith(2, 2);
  });
});
