import { injectHostKeyFingerprint, toBase64Url } from "@palladin/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectPairedNativeAgentProvider,
  parseSecureFrame,
  parseSessionReady,
  readVerifiedPairing,
} from "./runtime";

const PUBLIC_KEY = toBase64Url(new Uint8Array(32));
const B32 = PUBLIC_KEY;
const SIGNATURE = toBase64Url(new Uint8Array(64));

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubChrome(stored: unknown): { readonly connectNative: ReturnType<typeof vi.fn> } {
  const connectNative = vi.fn();
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({ agentInjectHostPairing: stored })) } },
    runtime: {
      getURL: vi.fn(() => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"),
      connectNative,
    },
    alarms: { create: vi.fn() },
  });
  return { connectNative };
}

describe("secure Native Messaging frame boundary", () => {
  it("does not open Native Messaging without a pre-existing verified host pin", async () => {
    const { connectNative } = stubChrome(undefined);
    await connectPairedNativeAgentProvider();
    expect(connectNative).not.toHaveBeenCalled();
  });

  it("accepts only a public host key whose stored fingerprint verifies", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    stubChrome({ hostSigningPublicKey: PUBLIC_KEY, fingerprint });
    await expect(readVerifiedPairing()).resolves.toEqual({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint,
    });

    stubChrome({ hostSigningPublicKey: PUBLIC_KEY, fingerprint: "b".repeat(43) });
    await expect(readVerifiedPairing()).resolves.toBeNull();
  });

  it("accepts only the frozen session.ready shape", () => {
    const ready = {
      protocol: "palladin.inject-provider.v1",
      type: "session.ready",
      extensionNonce: B32,
      hostNonce: B32,
      hostEphemeralPublicKey: B32,
      hostSigningPublicKey: B32,
      signature: SIGNATURE,
      sessionId: B32,
    };
    expect(parseSessionReady(ready)).toEqual(ready);
    expect(parseSessionReady({ ...ready, hostPublicKey: B32 })).toBeNull();
    expect(parseSessionReady({ ...ready, signature: "not-base64url" })).toBeNull();
  });

  it("accepts canonical secure sequence text and rejects plaintext provider frames", () => {
    const secure = {
      protocol: "palladin.inject-provider.v1",
      type: "secure",
      sessionId: B32,
      sequence: "0",
      ciphertext: "ciphertext_base64url",
    };
    expect(parseSecureFrame(secure)).toEqual(secure);
    expect(parseSecureFrame({ ...secure, sequence: "00" })).toBeNull();
    expect(parseSecureFrame({
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "n".repeat(32),
    })).toBeNull();
  });
});
