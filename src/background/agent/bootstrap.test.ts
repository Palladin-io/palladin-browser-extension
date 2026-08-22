import { describe, expect, it, vi } from "vitest";

import { startNativeAgentBridge, type NativeAgentStartupEvent } from "./bootstrap";

describe("native Agent bridge bootstrap", () => {
  it("starts immediately and reconnects on browser startup without a Vault session", () => {
    let onStartup: (() => void) | undefined;
    const startup: NativeAgentStartupEvent = {
      addListener: vi.fn((listener) => {
        onStartup = listener;
      }),
    };
    const connect = vi.fn();

    startNativeAgentBridge(startup, connect);

    expect(connect).toHaveBeenCalledOnce();
    expect(startup.addListener).toHaveBeenCalledOnce();
    onStartup?.();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
