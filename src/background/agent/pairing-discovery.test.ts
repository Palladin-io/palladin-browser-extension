import { injectHostKeyFingerprint } from "@palladin/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import { discoverNativeAgentPairingOffer } from "./pairing-discovery";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const KEY = `${"a".repeat(42)}A`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeNativeMessage() {
  let resolveResponse: ((raw: unknown) => void) | undefined;
  const sendNativeMessage = vi.fn((_hostName: string, _request: unknown) => new Promise<unknown>((resolve) => {
    resolveResponse = resolve;
  }));
  return {
    sendNativeMessage,
    emitMessage: (raw: unknown) => resolveResponse?.(raw),
  };
}

function stubChrome(native: ReturnType<typeof fakeNativeMessage>): void {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn(() => EXTENSION_ORIGIN),
      sendNativeMessage: native.sendNativeMessage,
    },
  });
}

describe("native Agent pairing discovery", () => {
  it("accepts one exact challenge-bound public offer from one native message", async () => {
    const native = fakeNativeMessage();
    stubChrome(native);
    const discovered = discoverNativeAgentPairingOffer();
    await vi.waitFor(() => expect(native.sendNativeMessage).toHaveBeenCalledOnce());
    const request = native.sendNativeMessage.mock.calls[0]?.[1] as Record<string, string>;
    const fingerprint = await injectHostKeyFingerprint(KEY);

    native.emitMessage({
      protocol: AGENT_PAIRING_PROTOCOL,
      type: "pairing.offer",
      extensionOrigin: EXTENSION_ORIGIN,
      challenge: request.challenge,
      hostSigningPublicKey: KEY,
      fingerprint,
    });

    await expect(discovered).resolves.toEqual({
      protocol: AGENT_PAIRING_PROTOCOL,
      hostSigningPublicKey: KEY,
      fingerprint,
    });
    expect(request).toMatchObject({
      protocol: AGENT_PAIRING_PROTOCOL,
      type: "pairing.discover",
      extensionOrigin: EXTENSION_ORIGIN,
    });
    expect(native.sendNativeMessage).toHaveBeenCalledWith("io.palladin.browser_bridge", request);
  });

  it("rejects a stale challenge and never returns its public key", async () => {
    const native = fakeNativeMessage();
    stubChrome(native);
    const discovered = discoverNativeAgentPairingOffer();
    await vi.waitFor(() => expect(native.sendNativeMessage).toHaveBeenCalledOnce());
    const fingerprint = await injectHostKeyFingerprint(KEY);

    native.emitMessage({
      protocol: AGENT_PAIRING_PROTOCOL,
      type: "pairing.offer",
      extensionOrigin: EXTENSION_ORIGIN,
      challenge: "00000000-0000-4000-8000-000000000001",
      hostSigningPublicKey: KEY,
      fingerprint,
    });

    await expect(discovered).rejects.toThrow("Invalid native-host pairing offer");
  });
});
