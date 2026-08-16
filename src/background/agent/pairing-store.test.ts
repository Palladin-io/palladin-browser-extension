import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHostPairingRecord,
  loadHostPairingSnapshot,
  saveHostPairingIntent,
  saveHostPairingRecord,
} from "./pairing-store";

const INTENT_TOKEN = "00000000-0000-4000-8000-000000000001";
const RECORD = {
  hostSigningPublicKey: `${"a".repeat(42)}A`,
  fingerprint: `${"b".repeat(42)}Q`,
  intentToken: INTENT_TOKEN,
};

const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({
    agentInjectHostPairing: RECORD,
    agentInjectHostPairingIntent: INTENT_TOKEN,
  });
  set.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { storage: { local: { get, set, remove } } });
});

describe("durable public host pairing store", () => {
  it("loads, saves, and clears only public pin consistency state", async () => {
    await expect(loadHostPairingSnapshot()).resolves.toEqual({
      record: RECORD,
      intentToken: INTENT_TOKEN,
    });
    await saveHostPairingIntent(INTENT_TOKEN);
    await saveHostPairingRecord(RECORD);
    await clearHostPairingRecord();

    expect(get).toHaveBeenCalledWith(["agentInjectHostPairing", "agentInjectHostPairingIntent"]);
    expect(set).toHaveBeenNthCalledWith(1, { agentInjectHostPairingIntent: INTENT_TOKEN });
    expect(set).toHaveBeenNthCalledWith(2, { agentInjectHostPairing: RECORD });
    expect(remove).toHaveBeenCalledWith("agentInjectHostPairing");
  });
});
