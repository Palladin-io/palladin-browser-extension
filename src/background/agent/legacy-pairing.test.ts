import { describe, expect, it, vi } from "vitest";

import { clearLegacyHostPairingState } from "./legacy-pairing";

describe("legacy Agent pairing migration", () => {
  it("removes both obsolete durable pairing records", async () => {
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { storage: { local: { remove } } });

    await clearLegacyHostPairingState();

    expect(remove).toHaveBeenCalledWith([
      "agentInjectHostPairing",
      "agentInjectHostPairingIntent",
    ]);
  });
});
