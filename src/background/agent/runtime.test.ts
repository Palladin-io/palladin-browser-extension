import { injectHostKeyFingerprint, toBase64Url } from "@palladin/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInjectionRequest } from "@shared/messaging";

import {
  handleNativeAgentMessage,
  type AgentFillDeps,
  type AgentProviderSession,
} from "./native-provider";
import {
  beginNativeAgentPairingMutation,
  connectPairedNativeAgentProvider,
  disconnectNativeAgentProvider,
  gateAgentFillDeps,
  handleNativeAgentAlarm,
  parseSecureFrame,
  parseSessionReady,
  readVerifiedPairing,
} from "./runtime";

const PUBLIC_KEY = toBase64Url(new Uint8Array(32));
const B32 = PUBLIC_KEY;
const SIGNATURE = toBase64Url(new Uint8Array(64));
const INTENT_TOKEN = "00000000-0000-4000-8000-000000000001";

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
  currentIntent: unknown = INTENT_TOKEN,
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
    storage: {
      local: {
        get: vi.fn(async () => ({
          agentInjectHostPairing: stored,
          agentInjectHostPairingIntent: currentIntent,
        })),
      },
    },
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
    stubChrome({ hostSigningPublicKey: PUBLIC_KEY, fingerprint, intentToken: INTENT_TOKEN });
    await expect(readVerifiedPairing()).resolves.toEqual({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint,
      intentToken: INTENT_TOKEN,
    });

    stubChrome({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint: toBase64Url(new Uint8Array(32).fill(2)),
      intentToken: INTENT_TOKEN,
    });
    await expect(readVerifiedPairing()).resolves.toBeNull();

    for (const malformed of [
      { hostSigningPublicKey: "not-base64url", fingerprint, intentToken: INTENT_TOKEN },
      { hostSigningPublicKey: "a".repeat(43), fingerprint, intentToken: INTENT_TOKEN },
      { hostSigningPublicKey: PUBLIC_KEY, fingerprint, intentToken: INTENT_TOKEN, extra: true },
      {
        hostSigningPublicKey: PUBLIC_KEY,
        fingerprint,
        intentToken: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      },
      { hostSigningPublicKey: PUBLIC_KEY },
    ]) {
      stubChrome(malformed);
      await expect(readVerifiedPairing()).resolves.toBeNull();
    }
  });

  it("rejects a stale active pin after restart when a later durable intent won", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    const laterIntent = "00000000-0000-4000-8000-000000000002";
    const { connectNative } = stubChrome(
      { hostSigningPublicKey: PUBLIC_KEY, fingerprint, intentToken: INTENT_TOKEN },
      fakeNativePort(),
      laterIntent,
    );

    await expect(readVerifiedPairing()).resolves.toBeNull();
    await connectPairedNativeAgentProvider();
    expect(connectNative).not.toHaveBeenCalled();
  });

  it("blocks reconnects until the newest pairing mutation releases its gate", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    const { connectNative } = stubChrome({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint,
      intentToken: INTENT_TOKEN,
    });
    const releaseOlderMutation = beginNativeAgentPairingMutation();
    const releaseCurrentMutation = beginNativeAgentPairingMutation();
    releaseOlderMutation.release();

    try {
      handleNativeAgentAlarm("palladin.native-agent.reconnect");
      await connectPairedNativeAgentProvider();
      expect(connectNative).not.toHaveBeenCalled();
    } finally {
      releaseCurrentMutation.release();
    }

    await connectPairedNativeAgentProvider();
    expect(connectNative).toHaveBeenCalledOnce();
  });

  it("disconnects and disposes a channel authenticated against the wrong pin", async () => {
    const fingerprint = await injectHostKeyFingerprint(PUBLIC_KEY);
    const { native } = stubChrome({
      hostSigningPublicKey: PUBLIC_KEY,
      fingerprint,
      intentToken: INTENT_TOKEN,
    });
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
      intentToken: INTENT_TOKEN,
    });
    await connectPairedNativeAgentProvider();

    disconnectNativeAgentProvider();
    native.emitDisconnect();

    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(alarmsClear).toHaveBeenCalledWith("palladin.native-agent.reconnect");
    expect(alarmsCreate).not.toHaveBeenCalled();
  });

  it("cancels a decrypted Inject before its next page side effect and wipes values", async () => {
    let active = true;
    let pageReads = 0;
    const page = {
      id: 7,
      page: { url: "https://login.example.com", documentId: "d".repeat(32) },
    };
    const base: AgentFillDeps = {
      getActivePage: vi.fn(async () => {
        pageReads += 1;
        if (pageReads === 2) active = false;
        return page;
      }),
      sendStep: vi.fn(async () => ({ ok: true } as const)),
      probeTransition: vi.fn(async () => ({ status: "ready" } as const)),
      wait: vi.fn(async () => undefined),
    };
    const gated = gateAgentFillDeps(base, () => active);
    const request: AgentInjectionRequest = {
      protocol: "palladin.inject-provider.v1",
      type: "inject",
      transactionId: "tx-cancelled",
      grantId: "grant-1",
      entryId: "entry-1",
      expectedDomain: "login.example.com",
      form: {
        version: 1,
        steps: [{
          fields: [{
            entryFieldId: "credential.password",
            selector: "#password",
            control: "password",
          }],
          submit: { action: "click", selector: "#submit" },
        }],
      },
      values: [{
        entryFieldId: "credential.password",
        value: "synthetic-password-value",
      }],
    };
    const session: AgentProviderSession = {
      prepared: { tabId: 7, documentId: "d".repeat(32) },
    };

    const response = await handleNativeAgentMessage(
      gated,
      { consume: vi.fn(async () => true) },
      session,
      request,
    );

    expect(response).toMatchObject({ outcome: "provider-unavailable" });
    expect(base.sendStep).not.toHaveBeenCalled();
    expect(base.probeTransition).not.toHaveBeenCalled();
    expect(request.values[0]?.value).toBe("");
    await expect(gated.sendStep(7, "login.example.com", request.form.steps[0]!, []))
      .resolves.toBeNull();
    await expect(gated.probeTransition(7, "login.example.com", "#password"))
      .resolves.toBeNull();
    expect(base.sendStep).not.toHaveBeenCalled();
    expect(base.probeTransition).not.toHaveBeenCalled();
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
    expect(parseSessionReady({ ...ready, extensionNonce: "a".repeat(43) })).toBeNull();
    expect(parseSessionReady({ ...ready, signature: "a".repeat(86) })).toBeNull();
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
