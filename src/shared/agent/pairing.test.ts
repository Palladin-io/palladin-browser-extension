import { describe, expect, it } from "vitest";

import {
  AGENT_PAIRING_PROTOCOL,
  parseAgentPairingBundle,
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
});
