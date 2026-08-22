import { describe, expect, it, vi } from "vitest";

import { createAgentPairingClient, AgentPairingClientError } from "./client";
import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

const FINGERPRINT = `${"b".repeat(42)}Q`;
const OFFER = {
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: `${"a".repeat(42)}A`,
  fingerprint: FINGERPRINT,
} as const;

describe("Agent pairing popup client", () => {
  it("requests and validates automatic native-host discovery", async () => {
    const send = vi.fn(async () => ({ ok: true as const, offer: OFFER }));
    const client = createAgentPairingClient(send);

    await expect(client.discover()).resolves.toEqual(OFFER);
    expect(send).toHaveBeenCalledWith({ type: "agent-pairing/discover" });
  });

  it("sends the explicit-confirmation save command", async () => {
    const send = vi.fn(async () => ({
      ok: true as const,
      status: { paired: true as const, fingerprint: FINGERPRINT },
    }));
    const client = createAgentPairingClient(send);

    await expect(client.save("bundle-json")).resolves.toEqual({
      paired: true,
      fingerprint: FINGERPRINT,
    });
    expect(send).toHaveBeenCalledWith({
      type: "agent-pairing/save",
      pairingBundle: "bundle-json",
      confirmed: true,
    });
  });

  it("rejects malformed worker replies", async () => {
    const client = createAgentPairingClient(vi.fn(async () => ({
      ok: true,
      status: { paired: true, fingerprint: FINGERPRINT, hostSigningPublicKey: "leak" },
    }) as never));
    await expect(client.getStatus()).rejects.toEqual(new AgentPairingClientError("unavailable"));
  });

  it("preserves the explicit not-committed failure code", async () => {
    const client = createAgentPairingClient(vi.fn(async () => ({
      ok: false as const,
      code: "mutation-not-committed" as const,
      message: "value-free",
    })));

    await expect(client.clear())
      .rejects.toEqual(new AgentPairingClientError("mutation-not-committed"));
  });

  it("preserves a recognized native host discovery failure code", async () => {
    const client = createAgentPairingClient(vi.fn(async () => ({
      ok: false as const,
      code: "native-host-not-found" as const,
      message: "value-free",
    })));

    await expect(client.discover())
      .rejects.toEqual(new AgentPairingClientError("native-host-not-found"));
  });
});
