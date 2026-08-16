import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import {
  createAgentPairingRuntimeHandler,
  type AgentPairingCommandDeps,
} from "./pairing-commands";

const KEY = `${"a".repeat(42)}A`;
const FINGERPRINT = `${"b".repeat(42)}Q`;
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
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({
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
    const effects = deps({ deriveFingerprint: vi.fn(async () => `${"c".repeat(42)}g`) });
    const handle = createAgentPairingRuntimeHandler(effects);
    const result = await handle({
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
    const handle = createAgentPairingRuntimeHandler(effects);
    const malformed = await handle({
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
    const handle = createAgentPairingRuntimeHandler(effects);
    const result = await handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: false,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-bundle" });
    expect(effects.savePairing).not.toHaveBeenCalled();
  });

  it("disconnects synchronously before awaiting durable clear", async () => {
    let releaseClear: (() => void) | undefined;
    const clearPairing = vi.fn(() => new Promise<void>((resolve) => {
      releaseClear = resolve;
    }));
    const effects = deps({ clearPairing });
    const handle = createAgentPairingRuntimeHandler(effects);

    const clearing = handle({ type: "agent-pairing/clear" });
    expect(effects.disconnect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(clearPairing).toHaveBeenCalledOnce());
    releaseClear?.();
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
  });

  it("always stays disconnected when durable clear fails", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({ type: "agent-pairing/clear" }))
      .resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.disconnect).toHaveBeenCalledOnce();

    const failing = deps({ clearPairing: vi.fn(async () => { throw new Error("storage"); }) });
    const handleFailing = createAgentPairingRuntimeHandler(failing);
    await expect(handleFailing({ type: "agent-pairing/clear" }))
      .resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(failing.disconnect).toHaveBeenCalledOnce();
  });

  it("lets a later clear cancel a save suspended in fingerprint derivation", async () => {
    let releaseDerive: ((fingerprint: string) => void) | undefined;
    const deriveFingerprint = vi.fn(() => new Promise<string>((resolve) => {
      releaseDerive = resolve;
    }));
    const effects = deps({ deriveFingerprint });
    const handle = createAgentPairingRuntimeHandler(effects);

    const pairing = handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });
    await vi.waitFor(() => expect(deriveFingerprint).toHaveBeenCalledOnce());
    const clearing = handle({ type: "agent-pairing/clear" });
    expect(effects.disconnect).toHaveBeenCalledTimes(2);

    releaseDerive?.(FINGERPRINT);
    await expect(pairing).resolves.toMatchObject({ ok: false, code: "superseded" });
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
    expect(effects.clearPairing).toHaveBeenCalledOnce();
  });

  it("reports only verified persisted status", async () => {
    const record = { hostSigningPublicKey: KEY, fingerprint: FINGERPRINT };
    const effects = deps({ readVerifiedPairing: vi.fn(async () => record) });
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({ type: "agent-pairing/status" }))
      .resolves.toEqual({ ok: true, status: { paired: true, fingerprint: FINGERPRINT } });
  });
});
