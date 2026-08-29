import { describe, expect, it, vi } from "vitest";

import { startNativeAgentBridge, type NativeAgentStartupEvent } from "./bootstrap";

describe("native Agent bridge bootstrap", () => {
  it("starts immediately, removes legacy pairing state, and reconnects without a Vault session", () => {
    let onStartup: (() => void) | undefined;
    const startup: NativeAgentStartupEvent = {
      addListener: vi.fn((listener) => {
        onStartup = listener;
      }),
    };
    const connect = vi.fn();
    const clearLegacyPairing = vi.fn(async () => undefined);

    startNativeAgentBridge(startup, connect, clearLegacyPairing, true);

    expect(connect).toHaveBeenCalledOnce();
    expect(clearLegacyPairing).toHaveBeenCalledOnce();
    expect(startup.addListener).toHaveBeenCalledOnce();
    onStartup?.();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("cleans legacy state but does not start an unsupported browser adapter", () => {
    const startup: NativeAgentStartupEvent = {
      addListener: vi.fn(),
    };
    const connect = vi.fn();
    const clearLegacyPairing = vi.fn(async () => undefined);

    startNativeAgentBridge(startup, connect, clearLegacyPairing, false);

    expect(clearLegacyPairing).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(startup.addListener).not.toHaveBeenCalled();
  });
});
