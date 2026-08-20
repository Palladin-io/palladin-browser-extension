import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureActiveTabSessionLiveness,
  installActiveTabSessionLiveness,
} from "./active-tab-liveness";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)["__testPalladinLiveness"];
});

describe("active-tab session liveness bootstrap", () => {
  it("injects only the fixed isolated heartbeat after an explicit popup action", async () => {
    const executeScript = vi.fn(async () => []);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn(async () => [{ id: 42 }]) },
      scripting: { executeScript },
    });

    await ensureActiveTabSessionLiveness();

    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42 },
      world: "ISOLATED",
      args: expect.arrayContaining([
        "palladin.session-liveness",
        "palladin.session/liveness",
        20_000,
      ]),
    }));
  });

  it("does nothing when no normal active tab is available", async () => {
    const executeScript = vi.fn(async () => []);
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn(async () => []) },
      scripting: { executeScript },
    });

    await ensureActiveTabSessionLiveness();

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("stops permanently when an injected tab belongs to a reloaded extension context", () => {
    vi.useFakeTimers();
    let disconnect: (() => void) | null = null;
    const runtime = {
      id: "extension-id",
      lastError: undefined as { message?: string } | undefined,
      connect: vi.fn(() => ({
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      })),
    };
    vi.stubGlobal("chrome", { runtime });
    vi.stubGlobal("addEventListener", vi.fn());

    installActiveTabSessionLiveness(
      "__testPalladinLiveness",
      "palladin.session-liveness",
      "palladin.session/liveness",
      20_000,
    );
    runtime.id = "";
    if (disconnect === null) throw new Error("disconnect listener not installed");
    (disconnect as () => void)();
    vi.runAllTimers();

    expect(runtime.connect).toHaveBeenCalledOnce();
  });
});
