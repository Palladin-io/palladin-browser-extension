import { describe, expect, it, vi } from "vitest";

import { SessionLivenessPublisher, type SessionLivenessPort } from "./liveness";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function fakePort(): SessionLivenessPort & {
  readonly disconnect: () => void;
  readonly postMessage: ReturnType<typeof vi.fn>;
} {
  let onDisconnect = (): void => undefined;
  return {
    onDisconnect: { addListener: (listener) => { onDisconnect = listener; } },
    postMessage: vi.fn(),
    disconnect: () => onDisconnect(),
  };
}

describe("SessionLivenessPublisher", () => {
  it("publishes only the coarse enabled state", async () => {
    const publisher = new SessionLivenessPublisher();
    const port = fakePort();
    publisher.register(port, async () => true);
    await Promise.resolve();

    expect(port.postMessage).toHaveBeenCalledWith({
      channel: "palladin.session/liveness",
      type: "control",
      enabled: true,
    });
  });

  it("does not let a stale initial read override a newer lock transition", async () => {
    const publisher = new SessionLivenessPublisher();
    const port = fakePort();
    const initial = deferred<boolean>();
    publisher.register(port, () => initial.promise);

    publisher.setEnabled(false);
    initial.resolve(true);
    await Promise.resolve();

    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("drops disconnected ports", () => {
    const publisher = new SessionLivenessPublisher();
    const port = fakePort();
    publisher.register(port, () => new Promise(() => undefined));
    port.disconnect();

    publisher.setEnabled(true);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
