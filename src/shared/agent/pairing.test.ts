import { describe, expect, it } from "vitest";

import {
  AGENT_PAIRING_PROTOCOL,
  parseAgentPairingBundle,
  parseAgentPairingOffer,
  shortenPublicIdentifier,
} from "./pairing";

const KEY = `${"a".repeat(42)}A`;
const FINGERPRINT = `${"b".repeat(42)}Q`;

describe("Agent runtime pairing bundle", () => {
  it("accepts only the frozen canonical JSON shape", () => {
    const bundle = {
      protocol: AGENT_PAIRING_PROTOCOL,
      hostSigningPublicKey: KEY,
      fingerprint: FINGERPRINT,
    };
    expect(parseAgentPairingBundle(JSON.stringify(bundle))).toEqual(bundle);
    expect(parseAgentPairingBundle(`\n${JSON.stringify(bundle)}\n`)).toEqual(bundle);
    expect(parseAgentPairingBundle(JSON.stringify({ ...bundle, extra: true }))).toBeNull();
    expect(parseAgentPairingBundle(JSON.stringify({ ...bundle, protocol: "pairing.v0" }))).toBeNull();
    expect(parseAgentPairingBundle(JSON.stringify({ ...bundle, fingerprint: "not-base64url" })))
      .toBeNull();
    expect(parseAgentPairingBundle(JSON.stringify({
      ...bundle,
      hostSigningPublicKey: "a".repeat(43),
    }))).toBeNull();
    expect(parseAgentPairingBundle("not-json")).toBeNull();
  });

  it("shows a public fingerprint with both its prefix and suffix", () => {
    expect(shortenPublicIdentifier("abcdefgh0123456789uvwxyz"))
      .toBe("abcdefgh…uvwxyz");
  });

  it("accepts only an exact offer bound to the current origin and challenge", () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
    const challenge = "00000000-0000-4000-8000-000000000001";
    const offer = {
      protocol: AGENT_PAIRING_PROTOCOL,
      type: "pairing.offer",
      extensionOrigin: origin,
      challenge,
      hostSigningPublicKey: KEY,
      fingerprint: FINGERPRINT,
    };
    expect(parseAgentPairingOffer(offer, origin, challenge)).toEqual({
      protocol: AGENT_PAIRING_PROTOCOL,
      hostSigningPublicKey: KEY,
      fingerprint: FINGERPRINT,
    });
    expect(parseAgentPairingOffer({ ...offer, challenge: "stale" }, origin, challenge)).toBeNull();
    expect(parseAgentPairingOffer({ ...offer, extra: true }, origin, challenge)).toBeNull();
  });
});
