import { describe, expect, it, vi } from "vitest";

import { createAgentPairingClient, AgentPairingClientError } from "./client";

const FINGERPRINT = "b".repeat(43);

describe("Agent pairing popup client", () => {
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
});
