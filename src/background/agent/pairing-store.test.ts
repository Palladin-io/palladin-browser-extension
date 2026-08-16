import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHostPairingRecord,
  loadHostPairingRecord,
  saveHostPairingRecord,
} from "./pairing-store";

const RECORD = {
  hostSigningPublicKey: `${"a".repeat(42)}A`,
  fingerprint: `${"b".repeat(42)}Q`,
};

const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ agentInjectHostPairing: RECORD });
  set.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { storage: { local: { get, set, remove } } });
});

describe("durable public host pairing store", () => {
  it("loads, saves, and clears only the public pin record", async () => {
    await expect(loadHostPairingRecord()).resolves.toEqual(RECORD);
    await saveHostPairingRecord(RECORD);
    await clearHostPairingRecord();

    expect(set).toHaveBeenCalledWith({ agentInjectHostPairing: RECORD });
    expect(remove).toHaveBeenCalledWith("agentInjectHostPairing");
  });
});
