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
  it("consumes a worker disconnect and immediately re-registers the document", () => {
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const consumeDisconnectReason = vi.fn(() => "worker" as const);
    createReconnectingWorkerPort(connect, vi.fn(), consumeDisconnectReason);

    first.emitDisconnect();

    expect(consumeDisconnectReason).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("stops after one immediate retry when no worker receiver exists", () => {
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const consumeDisconnectReason = vi.fn(() => "worker" as const);
    createReconnectingWorkerPort(connect, vi.fn(), consumeDisconnectReason);

    first.emitDisconnect();
    second.emitDisconnect();

    expect(consumeDisconnectReason).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("waits for BFCache pageshow before replacing the disconnected Port", () => {
    const first = fakePort();
    const second = fakePort();
    const onMessage = vi.fn();
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const bridge = createReconnectingWorkerPort(
      connect,
      onMessage,
      vi.fn(() => "bfcache" as const),
    );

    first.emitDisconnect();
    expect(connect).toHaveBeenCalledOnce();
    bridge.reconnect();
    second.emitMessage({ type: "bridge/pong" });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith({ type: "bridge/pong" });
  });

  it("permanently stops reconnecting after the extension context is invalidated", () => {
    const first = fakePort();
    const connect = vi.fn(() => first);
    const bridge = createReconnectingWorkerPort(
      connect,
      vi.fn(),
      vi.fn(() => "context-invalidated" as const),
    );

    first.emitDisconnect();
    bridge.postMessage({ type: "bridge/ping", at: 123 });
    bridge.reconnect();

    expect(connect).toHaveBeenCalledOnce();
    expect(first.postMessage).not.toHaveBeenCalled();
  });

  it("does not retry a message that throws an invalidated-context error", () => {
    const first = fakePort();
    vi.mocked(first.postMessage).mockImplementation(() => {
      throw new Error("Extension context invalidated.");
    });
    const connect = vi.fn(() => first);
    const bridge = createReconnectingWorkerPort(
      connect,
      vi.fn(),
      vi.fn(() => "worker" as const),
    );

    bridge.postMessage({ type: "bridge/ping", at: 123 });
    bridge.postMessage({ type: "bridge/ping", at: 456 });

    expect(connect).toHaveBeenCalledOnce();
    expect(first.postMessage).toHaveBeenCalledOnce();
  });

  it("reopens and retries once when postMessage observes a dead Port", () => {
    const first = fakePort();
    const second = fakePort();
    vi.mocked(first.postMessage).mockImplementationOnce(() => { throw new Error("closed"); });
    const connect = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const bridge = createReconnectingWorkerPort(
      connect,
      vi.fn(),
      vi.fn(() => "worker" as const),
    );
    const message = { type: "bridge/ping", at: 123 } as const;

    bridge.postMessage(message);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.postMessage).toHaveBeenCalledWith(message);
    expect(second.postMessage).toHaveBeenCalledWith(message);
  });
});
