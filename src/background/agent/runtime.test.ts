import {
  INJECT_PROVIDER_PROTOCOL,
  createInjectClientSession,
  fromBase64Url,
  toBase64Url,
  type InjectClientSession,
  type InjectSecureChannel,
} from "@palladin/crypto";
import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInjectionRequest } from "@shared/messaging";

import secureSessionContract from "./fixtures/inject-provider/v1/secure-session.json";

import {
  handleNativeAgentMessage,
  type AgentFillDeps,
  type AgentProviderSession,
} from "./native-provider";
import {
  connectNativeAgentProvider,
  connectNativeAgentProviderNow,
  disconnectNativeAgentProvider,
  gateAgentFillDeps,
  getPageById,
  handleNativeAgentAlarm,
  parseSecureFrame,
  parseSessionOffer,
  parseSessionReady,
} from "./runtime";

const PUBLIC_KEY = toBase64Url(new Uint8Array(32));
const B32 = PUBLIC_KEY;
const SIGNATURE = toBase64Url(new Uint8Array(64));

afterEach(() => {
  vi.useRealTimers();
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
    runtime: {
      getURL: vi.fn(() => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"),
      connectNative,
      lastError: undefined,
    },
    alarms: { create: alarmsCreate, clear: alarmsClear },
  });
  return { connectNative, alarmsCreate, alarmsClear, native };
}

function rustFixtureJsonBytes(value: Record<string, unknown>): Uint8Array {
  const sorted = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
  return new TextEncoder().encode(JSON.stringify(sorted));
}

describe("secure Native Messaging frame boundary", () => {
  it("opens and seals the exact shared CLI host secure-session contract", async () => {
    expect(secureSessionContract.protocol).toBe("palladin.inject-provider.v1");
    const offer = parseSessionOffer(secureSessionContract.offer);
    const ready = parseSessionReady(secureSessionContract.ready);
    const firstHostFrame = parseSecureFrame(secureSessionContract.firstHostFrame);
    expect(offer).toEqual(secureSessionContract.offer);
    expect(ready).toEqual(secureSessionContract.ready);
    expect(ready?.hostSigningPublicKey).toBe(offer?.hostSigningPublicKey);
    expect(firstHostFrame).toEqual(secureSessionContract.firstHostFrame);

    await sodium.ready;
    const extensionPrivateKey = fromBase64Url(
      secureSessionContract.syntheticInputs.extensionEphemeralSecretKey,
      32,
    );
    const extensionNonce = fromBase64Url(
      secureSessionContract.syntheticInputs.extensionNonce,
      32,
    );
    const randomSource = sodium as unknown as {
      randombytes_buf(length: number): Uint8Array;
    };
    const randomBytes = vi.spyOn(randomSource, "randombytes_buf")
      .mockReturnValueOnce(new Uint8Array(extensionPrivateKey))
      .mockReturnValueOnce(new Uint8Array(extensionNonce));
    let session: InjectClientSession | null = null;
    let channel: InjectSecureChannel | null = null;

    try {
      session = await createInjectClientSession({
        protocol: INJECT_PROVIDER_PROTOCOL,
        extensionOrigin: secureSessionContract.extensionOrigin,
        pinnedHostSigningPublicKey: secureSessionContract.offer.hostSigningPublicKey,
      });
      expect(session.openFrame).toEqual(secureSessionContract.open);
      channel = await session.acceptReady(ready!);

      const hostPlaintext = await channel.open(firstHostFrame!);
      try {
        expect(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(hostPlaintext)))
          .toEqual(secureSessionContract.firstHostPlaintext);
      } finally {
        hostPlaintext.fill(0);
      }

      const extensionPlaintext = rustFixtureJsonBytes(
        secureSessionContract.firstExtensionPlaintext,
      );
      try {
        await expect(channel.seal(extensionPlaintext))
          .resolves.toEqual(secureSessionContract.firstExtensionFrame);
      } finally {
        extensionPlaintext.fill(0);
      }
    } finally {
      channel?.dispose();
      session?.dispose();
      randomBytes.mockRestore();
      extensionPrivateKey.fill(0);
      extensionNonce.fill(0);
    }
  });

  it("starts the bridge without consulting a host pin, Vault lock, or popup state", async () => {
    const { connectNative } = stubChrome();

    connectNativeAgentProvider();

    await vi.waitFor(() => expect(connectNative).toHaveBeenCalledOnce());
  });

  it("opens Native Messaging automatically on the first connection", async () => {
    const { connectNative, native } = stubChrome();

    await connectNativeAgentProviderNow();

    expect(connectNative).toHaveBeenCalledOnce();
    expect(native.postMessage).not.toHaveBeenCalled();
    native.emitMessage({
      protocol: INJECT_PROVIDER_PROTOCOL,
      type: "session.offer",
      hostSigningPublicKey: PUBLIC_KEY,
    });
    await vi.waitFor(() => expect(native.postMessage).toHaveBeenCalledOnce());
    expect(native.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      protocol: INJECT_PROVIDER_PROTOCOL,
      type: "session.open",
    }));
  });

  it("fails a hung public tab probe closed within a bounded time", async () => {
    vi.useFakeTimers();
    stubChrome();
    chrome.tabs = {
      sendMessage: vi.fn(() => new Promise(() => undefined)),
    } as unknown as typeof chrome.tabs;

    const pending = getPageById(7);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({ id: 7, page: null });
  });

  it("reconnects when the Native Messaging alarm fires", async () => {
    const { connectNative } = stubChrome();

    handleNativeAgentAlarm("palladin.native-agent.reconnect");

    await vi.waitFor(() => expect(connectNative).toHaveBeenCalledOnce());
  });

  it("ignores a stale reconnect alarm on unsupported browser targets", async () => {
    const { connectNative } = stubChrome();

    handleNativeAgentAlarm("palladin.native-agent.reconnect", false);

    expect(connectNative).not.toHaveBeenCalled();
  });

  it("backs off repeated connection failures and resets after lifecycle teardown", async () => {
    const { connectNative, alarmsCreate } = stubChrome();
    connectNative.mockImplementation(() => {
      throw new Error("native host unavailable");
    });

    await connectNativeAgentProviderNow();
    await connectNativeAgentProviderNow();

    expect(alarmsCreate).toHaveBeenNthCalledWith(
      1,
      "palladin.native-agent.reconnect",
      { delayInMinutes: 0.5 },
    );
    expect(alarmsCreate).toHaveBeenNthCalledWith(
      2,
      "palladin.native-agent.reconnect",
      { delayInMinutes: 1 },
    );

    disconnectNativeAgentProvider();
    await connectNativeAgentProviderNow();

    expect(alarmsCreate).toHaveBeenNthCalledWith(
      3,
      "palladin.native-agent.reconnect",
      { delayInMinutes: 0.5 },
    );
  });

  it("disconnects and disposes a channel with an invalid signed transcript", async () => {
    const { native, alarmsCreate } = stubChrome();
    await connectNativeAgentProviderNow();
    native.emitMessage({
      protocol: INJECT_PROVIDER_PROTOCOL,
      type: "session.offer",
      hostSigningPublicKey: PUBLIC_KEY,
    });
    await vi.waitFor(() => expect(native.postMessage).toHaveBeenCalledOnce());
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
    expect(alarmsCreate).toHaveBeenCalledWith(
      "palladin.native-agent.reconnect",
      { delayInMinutes: 0.5 },
    );
  });

  it("explicit lifecycle teardown cannot schedule reconnection from the disconnect event", async () => {
    const { native, alarmsCreate, alarmsClear } = stubChrome();
    await connectNativeAgentProviderNow();

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
      getActivePage: vi.fn(async () => page),
      getPageById: vi.fn(async () => {
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
    await expect(gated.sendStep(
      7,
      "login.example.com",
      "d".repeat(32),
      request.form.steps[0]!,
      [],
    ))
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

  it("accepts only a value-free session.offer with one canonical public key", () => {
    const offer = {
      protocol: INJECT_PROVIDER_PROTOCOL,
      type: "session.offer",
      hostSigningPublicKey: B32,
    };
    expect(parseSessionOffer(offer)).toEqual(offer);
    expect(parseSessionOffer({ ...offer, extensionId: "attacker-controlled" })).toBeNull();
    expect(parseSessionOffer({ ...offer, hostSigningPublicKey: "not-base64url" })).toBeNull();
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
