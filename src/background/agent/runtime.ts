import {
  INJECT_PROVIDER_PROTOCOL,
  createInjectClientSession,
  injectHostKeyFingerprint,
  type InjectClientSession,
  type InjectSecureChannel,
  type InjectSecureFrame,
  type InjectSessionReady,
} from "@palladin/crypto";
import {
  AGENT_INJECT_PROTOCOL,
  AGENT_INJECT_STEP_CHANNEL,
  AGENT_INJECT_TRANSITION_CHANNEL,
  TAB_URL_REQUEST_CHANNEL,
  isAgentInjectStepOutcome,
  isAgentInjectTransitionOutcome,
  isTabUrlResponse,
  type AgentInjectFieldValue,
  type AgentInjectFormStep,
  type AgentInjectStepOutcome,
  type AgentInjectTransitionOutcome,
} from "@shared/messaging";
import { isCanonicalBase64Url32 } from "@shared/agent/pairing";

import { logger } from "../telemetry/logger";
import {
  isHostPairingIntentToken,
  loadHostPairingSnapshot,
  type HostPairingRecord,
} from "./pairing-store";
import {
  NATIVE_HOST_NAME,
  handleNativeAgentMessage,
  type AgentFillDeps,
  type AgentProviderSession,
  type AgentTabState,
  type TransactionReplayGuard,
} from "./native-provider";

const REPLAY_KEY = "agentInjectTransactionIds";
const MAX_REPLAY_IDS = 1_024;
const RECONNECT_ALARM = "palladin.native-agent.reconnect";
const MAX_SECURE_FRAME_LENGTH = 2 * 1024 * 1024;

class SessionReplayGuard implements TransactionReplayGuard {
  private queue: Promise<boolean> = Promise.resolve(true);

  consume(transactionId: string): Promise<boolean> {
    const next = this.queue.then(async () => {
      const stored = await chrome.storage.session.get(REPLAY_KEY);
      const ids = Array.isArray(stored[REPLAY_KEY])
        ? stored[REPLAY_KEY].filter((value): value is string => typeof value === "string")
        : [];
      if (ids.includes(transactionId)) return false;
      const updated = [...ids.slice(-(MAX_REPLAY_IDS - 1)), transactionId];
      await chrome.storage.session.set({ [REPLAY_KEY]: updated });
      return true;
    });
    this.queue = next.catch(() => false);
    return next;
  }
}

const replay = new SessionReplayGuard();
let nativePort: chrome.runtime.Port | null = null;
let clientSession: InjectClientSession | null = null;
let secureChannel: InjectSecureChannel | null = null;
let connectionAttempt: Promise<void> | null = null;
let lifecycleVersion = 0;
let pairingMutationGeneration = 0;
let pairingMutationSuppressed = false;

const agentFillDeps: AgentFillDeps = {
  getActivePage,
  sendStep,
  probeTransition,
};

/** Gate every awaited lookup and page operation against pairing lifecycle. */
export function gateAgentFillDeps(
  deps: AgentFillDeps,
  isActive: () => boolean,
): AgentFillDeps {
  return {
    async getActivePage() {
      if (!isActive()) return null;
      const page = await deps.getActivePage();
      return isActive() ? page : null;
    },
    async sendStep(tabId, expectedDomain, step, values) {
      if (!isActive()) return null;
      const outcome = await deps.sendStep(tabId, expectedDomain, step, values);
      return isActive() ? outcome : null;
    },
    async probeTransition(tabId, expectedDomain, selector) {
      if (!isActive()) return null;
      const outcome = await deps.probeTransition(tabId, expectedDomain, selector);
      return isActive() ? outcome : null;
    },
    async wait(milliseconds) {
      if (!isActive()) return;
      if (deps.wait) {
        await deps.wait(milliseconds);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      }
    },
  };
}

export function connectNativeAgentProvider(): void {
  void connectPairedNativeAgentProvider();
}

export function handleNativeAgentAlarm(name: string): void {
  if (name === RECONNECT_ALARM && !pairingMutationSuppressed) connectNativeAgentProvider();
}

export async function connectPairedNativeAgentProvider(): Promise<void> {
  if (pairingMutationSuppressed) return;
  if (nativePort !== null) return;
  if (connectionAttempt !== null) return connectionAttempt;
  const attempt = openPairedNativeAgentProvider(lifecycleVersion);
  connectionAttempt = attempt;
  try {
    await attempt;
  } finally {
    if (connectionAttempt === attempt) connectionAttempt = null;
  }
}

/**
 * Suppress every automatic/manual reconnect for one pairing mutation.
 *
 * Generation ownership means completion of an older superseded mutation cannot
 * release a newer mutation's suppression. Calling the returned release twice is
 * harmless.
 */
export function beginNativeAgentPairingMutation(): () => void {
  const generation = ++pairingMutationGeneration;
  pairingMutationSuppressed = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (generation === pairingMutationGeneration) pairingMutationSuppressed = false;
  };
}

async function openPairedNativeAgentProvider(expectedLifecycle: number): Promise<void> {
  const pairing = await readVerifiedPairing();
  if (pairingMutationSuppressed
    || pairing === null
    || nativePort !== null
    || lifecycleVersion !== expectedLifecycle) return;
  let nextClient: InjectClientSession | null = null;
  let port: chrome.runtime.Port;
  try {
    nextClient = await createInjectClientSession({
      protocol: INJECT_PROVIDER_PROTOCOL,
      extensionOrigin: chrome.runtime.getURL(""),
      pinnedHostSigningPublicKey: pairing.hostSigningPublicKey,
    });
    if (pairingMutationSuppressed
      || nativePort !== null
      || lifecycleVersion !== expectedLifecycle) {
      nextClient.dispose();
      return;
    }
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    clientSession = nextClient;
    nativePort = port;
    const providerSession: AgentProviderSession = { prepared: null };
    const isActive = () => nativePort === port && lifecycleVersion === expectedLifecycle;
    const lifecycleDeps = gateAgentFillDeps(agentFillDeps, isActive);
    let queue = Promise.resolve();
    port.onMessage.addListener((raw) => {
      queue = queue
        .then(() => handleSecureNativeMessage(
          port,
          providerSession,
          lifecycleDeps,
          expectedLifecycle,
          raw,
        ))
        .catch(() => disconnectSecurePort(port));
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      // Explicit unpair/re-pair disposes first, so its disconnect event cannot
      // resurrect the old channel through the reconnect alarm.
      if (nativePort !== port) return;
      providerSession.prepared = null;
      disposeSecureSession(port);
      chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
    });
    port.postMessage(nextClient.openFrame);
  } catch {
    nextClient?.dispose();
    if (lifecycleVersion !== expectedLifecycle) return;
    disposeSecureSession();
    logger.debug("paired native Agent provider unavailable");
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
  }
}

/** Stop reconnects and synchronously dispose all ephemeral channel material. */
export function disconnectNativeAgentProvider(): void {
  lifecycleVersion += 1;
  // A stale in-flight attempt observes the lifecycle change and disposes its
  // own client. Clearing this slot lets a newly saved pin connect immediately.
  connectionAttempt = null;
  const port = nativePort;
  disposeSecureSession(port ?? undefined);
  if (port !== null) {
    try {
      port.disconnect();
    } catch {
      // The port is already detached and all channel material is disposed.
    }
  }
  if (typeof chrome !== "undefined") void chrome.alarms.clear(RECONNECT_ALARM);
}

async function handleSecureNativeMessage(
  port: chrome.runtime.Port,
  providerSession: AgentProviderSession,
  deps: AgentFillDeps,
  expectedLifecycle: number,
  raw: unknown,
): Promise<void> {
  const isActive = () => nativePort === port && lifecycleVersion === expectedLifecycle;
  if (!isActive()) return;
  if (secureChannel === null) {
    const ready = parseSessionReady(raw);
    const session = clientSession;
    if (ready === null || session === null) throw new Error("Invalid secure session ready frame");
    const channel = await session.acceptReady(ready);
    if (!isActive() || clientSession !== session) {
      channel.dispose();
      return;
    }
    secureChannel = channel;
    clientSession = null;
    return;
  }
  const channel = secureChannel;
  const frame = parseSecureFrame(raw);
  if (frame === null) throw new Error("Plain or malformed Native Messaging frame rejected");
  const plaintext = await channel.open(frame);
  if (!isActive()) {
    plaintext.fill(0);
    return;
  }
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
  const response = await handleNativeAgentMessage(deps, replay, providerSession, request)
    .catch(() => unavailableResponse(request));
  if (!isActive()) return;
  const responseBytes = new TextEncoder().encode(JSON.stringify(response));
  try {
    postIfConnected(port, await channel.seal(responseBytes));
  } finally {
    responseBytes.fill(0);
  }
}

export async function readVerifiedPairing(): Promise<HostPairingRecord | null> {
  const { record: candidate, intentToken } = await loadHostPairingSnapshot();
  if (!isHostPairingIntentToken(intentToken)) return null;
  if (!isHostPairingRecord(candidate)) return null;
  if (candidate.intentToken !== intentToken) return null;
  try {
    return await injectHostKeyFingerprint(candidate.hostSigningPublicKey) === candidate.fingerprint
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function isHostPairingRecord(value: unknown): value is HostPairingRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && isCanonicalBase64Url32(record.hostSigningPublicKey)
    && isCanonicalBase64Url32(record.fingerprint)
    && isHostPairingIntentToken(record.intentToken);
}

export function parseSessionReady(value: unknown): InjectSessionReady | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const keys = ["protocol", "type", "extensionNonce", "hostNonce", "hostEphemeralPublicKey", "hostSigningPublicKey", "signature", "sessionId"];
  if (Object.keys(frame).length !== keys.length || !keys.every((key) => key in frame)) return null;
  if (frame.protocol !== INJECT_PROVIDER_PROTOCOL || frame.type !== "session.ready") return null;
  if (![frame.extensionNonce, frame.hostNonce, frame.hostEphemeralPublicKey, frame.hostSigningPublicKey]
    .every(isCanonicalBase64Url32)) return null;
  if (typeof frame.signature !== "string"
    || !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(frame.signature)) return null;
  if (!isCanonicalBase64Url32(frame.sessionId)) return null;
  return frame as unknown as InjectSessionReady;
}

export function parseSecureFrame(value: unknown): InjectSecureFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).length !== 5
    || frame.protocol !== INJECT_PROVIDER_PROTOCOL
    || frame.type !== "secure"
    || !isCanonicalBase64Url32(frame.sessionId)
    || typeof frame.sequence !== "string"
    || !/^(0|[1-9][0-9]{0,19})$/.test(frame.sequence)
    || typeof frame.ciphertext !== "string"
    || frame.ciphertext.length < 1
    || frame.ciphertext.length > MAX_SECURE_FRAME_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(frame.ciphertext)) return null;
  return frame as unknown as InjectSecureFrame;
}

function disconnectSecurePort(port: chrome.runtime.Port): void {
  try {
    port.disconnect();
  } finally {
    disposeSecureSession(port);
  }
}

function disposeSecureSession(port?: chrome.runtime.Port): void {
  if (port !== undefined && nativePort !== port) return;
  secureChannel?.dispose();
  clientSession?.dispose();
  secureChannel = null;
  clientSession = null;
  nativePort = null;
}

async function getActivePage(): Promise<AgentTabState | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  try {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      { channel: TAB_URL_REQUEST_CHANNEL },
      { frameId: 0 },
    );
    return {
      id: tab.id,
      page: isTabUrlResponse(response)
        ? { url: response.url, documentId: response.documentId }
        : null,
    };
  } catch {
    return { id: tab.id, page: null };
  }
}

async function sendStep(
  tabId: number,
  expectedDomain: string,
  step: AgentInjectFormStep,
  values: readonly AgentInjectFieldValue[],
): Promise<AgentInjectStepOutcome | null> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain, step, values },
      { frameId: 0 },
    );
    return isAgentInjectStepOutcome(response) ? response : null;
  } catch {
    return null;
  }
}

async function probeTransition(
  tabId: number,
  expectedDomain: string,
  selector: string,
): Promise<AgentInjectTransitionOutcome | null> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { channel: AGENT_INJECT_TRANSITION_CHANNEL, expectedDomain, selector },
      { frameId: 0 },
    );
    return isAgentInjectTransitionOutcome(response) ? response : null;
  } catch {
    return null;
  }
}

function postIfConnected(port: chrome.runtime.Port, response: unknown): void {
  if (nativePort !== port) return;
  try {
    port.postMessage(response);
  } catch {
    // The disconnect listener owns reconnection. Never log the secret-bearing frame.
  }
}

function unavailableResponse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const message = raw as Record<string, unknown>;
    if (message.type === "prepare") {
      return {
        protocol: AGENT_INJECT_PROTOCOL,
        type: "prepare.result",
        nonce: typeof message.nonce === "string" ? message.nonce : null,
        currentUrl: null,
        outcome: "provider-unavailable",
      };
    }
    return {
      protocol: AGENT_INJECT_PROTOCOL,
      type: "inject.result",
      transactionId: typeof message.transactionId === "string" ? message.transactionId : null,
      outcome: "provider-unavailable",
    };
  }
  return {
    protocol: AGENT_INJECT_PROTOCOL,
    type: "inject.result",
    transactionId: null,
    outcome: "provider-unavailable",
  };
}
