import { injectHostKeyFingerprint } from "@palladin/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import { discoverNativeAgentPairingOffer } from "./pairing-discovery";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const KEY = `${"a".repeat(42)}A`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakePort() {
  const messageListeners = new Set<(raw: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  const port = {
    name: "io.palladin.browser_bridge",
    sender: undefined,
    error: undefined,
    onMessage: {
      addListener: vi.fn((listener: (raw: unknown) => void) => messageListeners.add(listener)),
      removeListener: vi.fn((listener: (raw: unknown) => void) => messageListeners.delete(listener)),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => disconnectListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => disconnectListeners.delete(listener)),
    },
    postMessage,
    disconnect,
  } as unknown as chrome.runtime.Port;
  return {
    port,
    postMessage,
    disconnect,
    emitMessage: (raw: unknown) => messageListeners.forEach((listener) => listener(raw)),
    emitDisconnect: () => disconnectListeners.forEach((listener) => listener()),
  };
}

function stubChrome(native: ReturnType<typeof fakePort>): void {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn(() => EXTENSION_ORIGIN),
      connectNative: vi.fn(() => native.port),
      lastError: undefined,
    },
  });
}

describe("native Agent pairing discovery", () => {
  it("accepts one exact challenge-bound public offer and closes the one-shot port", async () => {
    const native = fakePort();
    stubChrome(native);
    const discovered = discoverNativeAgentPairingOffer();
    await vi.waitFor(() => expect(native.postMessage).toHaveBeenCalledOnce());
    const request = native.postMessage.mock.calls[0]?.[0] as Record<string, string>;
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
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

  it("rejects a stale challenge and never returns its public key", async () => {
    const native = fakePort();
    stubChrome(native);
    const discovered = discoverNativeAgentPairingOffer();
    await vi.waitFor(() => expect(native.postMessage).toHaveBeenCalledOnce());
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
    expect(native.disconnect).toHaveBeenCalledOnce();
  });
});
