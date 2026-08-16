import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import {
  dispatchAgentPairingCommand,
  handleAgentPairingRuntimeMessage,
  type AgentPairingCommandDeps,
} from "./pairing-commands";

const KEY = "a".repeat(43);
const FINGERPRINT = "b".repeat(43);
const BUNDLE = JSON.stringify({
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: KEY,
  fingerprint: FINGERPRINT,
});

function deps(overrides: Partial<AgentPairingCommandDeps> = {}): AgentPairingCommandDeps {
  return {
    readVerifiedPairing: vi.fn(async () => null),
    deriveFingerprint: vi.fn(async () => FINGERPRINT),
    savePairing: vi.fn(async () => undefined),
    clearPairing: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe("Agent pairing popup commands", () => {
  it("persists only the verified public key and derived fingerprint, then connects", async () => {
    const effects = deps();
    await expect(dispatchAgentPairingCommand(effects, {
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    })).resolves.toEqual({ ok: true, status: { paired: true, fingerprint: FINGERPRINT } });

    expect(effects.savePairing).toHaveBeenCalledWith({
      hostSigningPublicKey: KEY,
      fingerprint: FINGERPRINT,
    });
    expect(effects.disconnect).toHaveBeenCalledOnce();
    expect(effects.connect).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched fingerprint without persisting or connecting", async () => {
    const effects = deps({ deriveFingerprint: vi.fn(async () => "c".repeat(43)) });
    const result = await dispatchAgentPairingCommand(effects, {
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });

    expect(result).toEqual({
      ok: false,
      code: "fingerprint-mismatch",
      message: "Pairing fingerprint does not match the host public key",
    });
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("rejects malformed commands and bundles with value-free errors", async () => {
    const effects = deps();
    const malformed = await handleAgentPairingRuntimeMessage(effects, {
      type: "agent-pairing/save",
      pairingBundle: `${BUNDLE}private-value`,
      confirmed: true,
      extra: true,
    });
    expect(malformed).toEqual({
      ok: false,
      code: "invalid-bundle",
      message: "Pairing bundle is invalid",
    });
    expect(JSON.stringify(malformed)).not.toContain("private-value");
    expect(effects.deriveFingerprint).not.toHaveBeenCalled();
    expect(effects.savePairing).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation at the worker boundary", async () => {
    const effects = deps();
    const result = await handleAgentPairingRuntimeMessage(effects, {
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: false,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-bundle" });
    expect(effects.savePairing).not.toHaveBeenCalled();
  });

  it("clears persistence and always disconnects the active secure session", async () => {
    const effects = deps();
    await expect(dispatchAgentPairingCommand(effects, { type: "agent-pairing/clear" }))
      .resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.disconnect).toHaveBeenCalledOnce();

    const failing = deps({ clearPairing: vi.fn(async () => { throw new Error("storage"); }) });
    await expect(dispatchAgentPairingCommand(failing, { type: "agent-pairing/clear" }))
      .resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(failing.disconnect).toHaveBeenCalledOnce();
  });

  it("reports only verified persisted status", async () => {
    const record = { hostSigningPublicKey: KEY, fingerprint: FINGERPRINT };
    const effects = deps({ readVerifiedPairing: vi.fn(async () => record) });
    await expect(dispatchAgentPairingCommand(effects, { type: "agent-pairing/status" }))
      .resolves.toEqual({ ok: true, status: { paired: true, fingerprint: FINGERPRINT } });
  });
});
