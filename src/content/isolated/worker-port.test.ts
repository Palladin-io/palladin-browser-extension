import { describe, expect, it, vi } from "vitest";

import { createReconnectingWorkerPort, type ContentWorkerPort } from "./worker-port";

interface FakePort extends ContentWorkerPort {
  emitDisconnect(): void;
  emitMessage(message: unknown): void;
}

function fakePort(): FakePort {
  let disconnectListener: (() => void) | null = null;
  let messageListener: ((message: unknown) => void) | null = null;
  return {
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    onDisconnect: { addListener: (listener) => { disconnectListener = listener; } },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    emitDisconnect: () => disconnectListener?.(),
    emitMessage: (message) => messageListener?.(message),
  };
}

describe("reconnecting isolated-world worker Port", () => {
  it("consumes the expected BFCache lastError and reconnects on the next post", () => {
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const consumeLastError = vi.fn();
    const bridge = createReconnectingWorkerPort(connect, vi.fn(), consumeLastError);

    bridge.postMessage({ type: "bridge/ping" });
    first.emitDisconnect();
    bridge.postMessage({ type: "bridge/ping" });

    expect(consumeLastError).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
  });

  it("replaces the cached Port explicitly on a BFCache pageshow", () => {
    const first = fakePort();
    const second = fakePort();
    const onMessage = vi.fn();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const bridge = createReconnectingWorkerPort(connect, onMessage, vi.fn());

    bridge.postMessage({ type: "bridge/ping" });
    bridge.reconnect();
    second.emitMessage({ type: "bridge/pong" });

    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith({ type: "bridge/pong" });
  });
});
