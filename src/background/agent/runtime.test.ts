import { injectHostKeyFingerprint, toBase64Url } from "@palladin/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectPairedNativeAgentProvider,
  disconnectNativeAgentProvider,
  parseSecureFrame,
  parseSessionReady,
  readVerifiedPairing,
} from "./runtime";

const PUBLIC_KEY = toBase64Url(new Uint8Array(32));
const B32 = PUBLIC_KEY;
const SIGNATURE = toBase64Url(new Uint8Array(64));

afterEach(() => {
  disconnectNativeAgentProvider();
  vi.unstubAllGlobals();
});

interface FakeNativePort {
  readonly port: chrome.runtime.Port;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  emitMessage(raw: unknown): void;
  emitDisconnect(): void;
}

function fakeNativePort(): FakeNativePort {
  let messageListener: ((raw: unknown) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  return {
    port: {
      name: "io.palladin.browser_bridge",
      sender: undefined,
      error: undefined,
      onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
      onDisconnect: { addListener: vi.fn((listener) => { disconnectListener = listener; }) },
      postMessage,
      disconnect,
    } as unknown as chrome.runtime.Port,
    postMessage,
    disconnect,
    emitMessage: (raw) => messageListener?.(raw),
    emitDisconnect: () => disconnectListener?.(),
  };
}

function stubChrome(
  stored: unknown,
  native = fakeNativePort(),
): {
  readonly connectNative: ReturnType<typeof vi.fn>;
  readonly alarmsCreate: ReturnType<typeof vi.fn>;
  readonly alarmsClear: ReturnType<typeof vi.fn>;
  readonly native: FakeNativePort;
} {
  const connectNative = vi.fn(() => native.port);
  const alarmsCreate = vi.fn();
  const alarmsClear = vi.fn(async () => true);
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({ agentInjectHostPairing: stored })) } },
    runtime: {
      getURL: vi.fn(() => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"),
      connectNative,
      lastError: undefined,
    },
    alarms: { create: alarmsCreate, clear: alarmsClear },
  });
  return { connectNative, alarmsCreate, alarmsClear, native };
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

    for (const malformed of [
      { hostSigningPublicKey: "not-base64url", fingerprint },
      { hostSigningPublicKey: PUBLIC_KEY, fingerprint, extra: true },
      { hostSigningPublicKey: PUBLIC_KEY },
    ]) {
      stubChrome(malformed);
      await expect(readVerifiedPairing()).resolves.toBeNull();
    }
  });

  it("disconnects and disposes a channel authenticated against the wrong pin", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    const { native } = stubChrome({ hostSigningPublicKey: PUBLIC_KEY, fingerprint });
    await connectPairedNativeAgentProvider();
    const open = native.postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(open).toMatchObject({ type: "session.open" });

    native.emitMessage({
      protocol: "palladin.inject-provider.v1",
      type: "session.ready",
      extensionNonce: open.extensionNonce,
      hostNonce: B32,
      hostEphemeralPublicKey: B32,
      hostSigningPublicKey: toBase64Url(new Uint8Array(32).fill(1)),
      signature: SIGNATURE,
      sessionId: B32,
    });

    await vi.waitFor(() => expect(native.disconnect).toHaveBeenCalledOnce());
  });

  it("explicit unpair teardown cannot schedule reconnection from the disconnect event", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    const { native, alarmsCreate, alarmsClear } = stubChrome({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint,
    });
    await connectPairedNativeAgentProvider();

    disconnectNativeAgentProvider();
    native.emitDisconnect();

    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(alarmsClear).toHaveBeenCalledWith("palladin.native-agent.reconnect");
    expect(alarmsCreate).not.toHaveBeenCalled();
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
