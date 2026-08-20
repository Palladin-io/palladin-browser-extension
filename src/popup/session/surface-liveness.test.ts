import { describe, expect, it, vi } from "vitest";

import {
  startSurfaceSessionLiveness,
  type SurfaceLivenessPort,
  type SurfaceLivenessTimers,
} from "./surface-liveness";

function listenerSlot<T extends (...args: never[]) => void>(): {
  readonly api: { addListener(listener: T): void };
  read(): T;
} {
  let listener: T | null = null;
  return {
    api: { addListener(next) { listener = next; } },
    read() {
      if (listener === null) throw new Error("listener not installed");
      return listener;
    },
  };
}

describe("side-panel session liveness", () => {
  it("sends only value-free pings while the worker reports unlocked", () => {
    const messages = listenerSlot<(message: unknown) => void>();
    const disconnects = listenerSlot<() => void>();
    const postMessage = vi.fn();
    const port: SurfaceLivenessPort = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage,
      disconnect: vi.fn(),
    };
    let interval: (() => void) | null = null;
    const timers: SurfaceLivenessTimers = {
      setInterval: vi.fn((callback, delay) => {
        expect(delay).toBe(20_000);
        interval = callback;
        return 1;
      }),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn(),
    };
    const subject = startSurfaceSessionLiveness({ connect: vi.fn(() => port) }, timers);

    messages.read()({ channel: "palladin.session/liveness", type: "control", enabled: true });
    if (interval === null) throw new Error("interval not installed");
    (interval as () => void)();
    expect(postMessage).toHaveBeenCalledWith({ channel: "palladin.session/liveness", type: "ping" });

    messages.read()({ channel: "palladin.session/liveness", type: "control", enabled: false });
    expect(timers.clearInterval).toHaveBeenCalledWith(1);
    subject.stop();
  });

  it("reconnects after a routine worker port disconnect", () => {
    const messages = listenerSlot<(message: unknown) => void>();
    const disconnects = listenerSlot<() => void>();
    const port: SurfaceLivenessPort = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    let reconnect: (() => void) | null = null;
    const connect = vi.fn(() => port);
    const timers: SurfaceLivenessTimers = {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback, delay) => {
        expect(delay).toBe(1_000);
        reconnect = callback;
        return 2;
      }),
      clearTimeout: vi.fn(),
    };
    const subject = startSurfaceSessionLiveness({ connect }, timers);

    disconnects.read()();
    if (reconnect === null) throw new Error("reconnect not installed");
    (reconnect as () => void)();
    expect(connect).toHaveBeenCalledTimes(2);
    subject.stop();
  });

  it("does not reconnect a side panel whose extension context was invalidated", () => {
    const messages = listenerSlot<(message: unknown) => void>();
    const disconnects = listenerSlot<() => void>();
    const port: SurfaceLivenessPort = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const connect = vi.fn(() => port);
    const timers: SurfaceLivenessTimers = {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn(),
    };
    const subject = startSurfaceSessionLiveness(
      { connect },
      timers,
      () => false,
    );

    disconnects.read()();

    expect(timers.setTimeout).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    subject.stop();
  });
});
