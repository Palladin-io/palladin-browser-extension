import {
  INJECT_PROVIDER_PROTOCOL,
  createInjectClientSession,
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
import { extensionBuildTarget } from "@shared/config/build-target";

import { logger } from "../telemetry/logger";
import {
  NATIVE_HOST_NAME,
  handleNativeAgentMessage,
  type AgentFillDeps,
  type AgentProviderSession,
  type AgentTabState,
  type TransactionReplayGuard,
} from "./native-provider";

const REPLAY_KEY = "agentInjectTransactionIds";
const RECONNECT_DELAY_KEY = "nativeAgentReconnectDelayMinutes";
const MAX_REPLAY_IDS = 1_024;
const RECONNECT_ALARM = "palladin.native-agent.reconnect";
const INITIAL_RECONNECT_DELAY_MINUTES = 0.5;
const MAX_RECONNECT_DELAY_MINUTES = 15;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_SECURE_FRAME_LENGTH = 2 * 1024 * 1024;
const TAB_PROBE_TIMEOUT_MS = 2_000;

export interface InjectSessionOffer {
  readonly protocol: typeof INJECT_PROVIDER_PROTOCOL;
  readonly type: "session.offer";
  readonly hostSigningPublicKey: string;
}

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
let handshakeTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
let lifecycleVersion = 0;
let reconnectDelayMinutes = INITIAL_RECONNECT_DELAY_MINUTES;
let reconnectDelayLoad: Promise<void> | null = null;

const agentFillDeps: AgentFillDeps = {
  getActivePage,
  getPageById,
  sendStep,
  probeTransition,
};

/** Gate every awaited lookup and page operation against connection lifecycle. */
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
    async getPageById(tabId) {
      if (!isActive()) return null;
      const page = await deps.getPageById(tabId);
      return isActive() ? page : null;
    },
    async sendStep(tabId, expectedDomain, documentId, step, values) {
      if (!isActive()) return null;
      const outcome = await deps.sendStep(tabId, expectedDomain, documentId, step, values);
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
  void connectNativeAgentProviderNow();
}

/** Do not let service-worker evaluation bypass a reconnect alarm that is already pending. */
export function connectNativeAgentProviderIfDue(): void {
  void connectNativeAgentProviderIfDueNow();
}

export async function connectNativeAgentProviderIfDueNow(): Promise<void> {
  const expectedLifecycle = lifecycleVersion;
  await loadReconnectDelay();
  if (lifecycleVersion !== expectedLifecycle) return;
  let pending: chrome.alarms.Alarm | undefined;
  try {
    pending = await chrome.alarms.get(RECONNECT_ALARM);
  } catch {
    return;
  }
  if (lifecycleVersion !== expectedLifecycle || pending !== undefined) return;
  await connectNativeAgentProviderForLifecycle(expectedLifecycle);
}

export function handleNativeAgentAlarm(
  name: string,
  bridgeSupported: boolean = extensionBuildTarget === "chromium",
): void {
  if (bridgeSupported && name === RECONNECT_ALARM) connectNativeAgentProvider();
}

export async function connectNativeAgentProviderNow(): Promise<void> {
  await connectNativeAgentProviderForLifecycle(lifecycleVersion);
}

async function connectNativeAgentProviderForLifecycle(
  expectedLifecycle: number,
): Promise<void> {
  await loadReconnectDelay();
  if (lifecycleVersion !== expectedLifecycle) return;
  if (nativePort !== null) return;
  if (connectionAttempt !== null) return connectionAttempt;
  const attempt = openNativeAgentProvider(expectedLifecycle);
  connectionAttempt = attempt;
  try {
    await attempt;
  } finally {
    if (connectionAttempt === attempt) connectionAttempt = null;
  }
}

async function openNativeAgentProvider(expectedLifecycle: number): Promise<void> {
  if (nativePort !== null || lifecycleVersion !== expectedLifecycle) return;
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    const providerSession: AgentProviderSession = { prepared: null };
    const isActive = () => nativePort === port
      && lifecycleVersion === expectedLifecycle;
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
      // An explicit lifecycle teardown disposes first, so its disconnect event
      // cannot resurrect the old channel through the reconnect alarm.
      if (nativePort !== port) return;
      providerSession.prepared = null;
      disposeSecureSession(port);
      scheduleNativeAgentReconnect(expectedLifecycle);
    });
    armHandshakeTimeout(port, expectedLifecycle);
  } catch {
    if (lifecycleVersion !== expectedLifecycle) return;
    disposeSecureSession();
    logger.debug("native Agent provider unavailable");
    scheduleNativeAgentReconnect(expectedLifecycle);
  }
}

/** Stop reconnects and synchronously dispose all ephemeral channel material. */
export function disconnectNativeAgentProvider(): void {
  lifecycleVersion += 1;
  reconnectDelayMinutes = INITIAL_RECONNECT_DELAY_MINUTES;
  reconnectDelayLoad = Promise.resolve();
  // A stale in-flight attempt observes the lifecycle change and disposes its
  // own client. Clearing this slot permits a later explicit reconnect.
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
  if (typeof chrome !== "undefined") {
    void chrome.alarms.clear(RECONNECT_ALARM);
    void chrome.storage.session.remove(RECONNECT_DELAY_KEY);
  }
}

async function handleSecureNativeMessage(
  port: chrome.runtime.Port,
  providerSession: AgentProviderSession,
  deps: AgentFillDeps,
  expectedLifecycle: number,
  raw: unknown,
): Promise<void> {
  const isActive = () => nativePort === port
    && lifecycleVersion === expectedLifecycle;
  if (!isActive()) return;
  if (clientSession === null && secureChannel === null) {
    const offer = parseSessionOffer(raw);
    if (offer === null) throw new Error("Invalid secure session offer frame");
    const session = await createInjectClientSession({
      protocol: INJECT_PROVIDER_PROTOCOL,
      extensionOrigin: chrome.runtime.getURL(""),
      pinnedHostSigningPublicKey: offer.hostSigningPublicKey,
    });
    if (!isActive() || clientSession !== null || secureChannel !== null) {
      session.dispose();
      return;
    }
    clientSession = session;
    postIfConnected(port, session.openFrame);
    armHandshakeTimeout(port, expectedLifecycle);
    return;
  }
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
    clearHandshakeTimeout();
    reconnectDelayMinutes = INITIAL_RECONNECT_DELAY_MINUTES;
    reconnectDelayLoad = Promise.resolve();
    void chrome.alarms.clear(RECONNECT_ALARM);
    void chrome.storage.session.remove(RECONNECT_DELAY_KEY);
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

function scheduleNativeAgentReconnect(expectedLifecycle: number): void {
  if (lifecycleVersion !== expectedLifecycle) return;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: reconnectDelayMinutes });
  reconnectDelayMinutes = Math.min(
    reconnectDelayMinutes * 2,
    MAX_RECONNECT_DELAY_MINUTES,
  );
  void chrome.storage.session
    .set({ [RECONNECT_DELAY_KEY]: reconnectDelayMinutes })
    .catch(() => undefined);
}

function loadReconnectDelay(): Promise<void> {
  if (reconnectDelayLoad === null) {
    const expectedLifecycle = lifecycleVersion;
    reconnectDelayLoad = (async () => {
      try {
        const stored = await chrome.storage.session.get(RECONNECT_DELAY_KEY);
        if (lifecycleVersion !== expectedLifecycle) return;
        const delay = stored[RECONNECT_DELAY_KEY];
        if (typeof delay === "number"
          && Number.isFinite(delay)
          && delay >= INITIAL_RECONNECT_DELAY_MINUTES
          && delay <= MAX_RECONNECT_DELAY_MINUTES) {
          reconnectDelayMinutes = delay;
        }
      } catch {
        if (lifecycleVersion === expectedLifecycle) {
          reconnectDelayMinutes = INITIAL_RECONNECT_DELAY_MINUTES;
        }
      }
    })();
  }
  return reconnectDelayLoad;
}

function armHandshakeTimeout(port: chrome.runtime.Port, expectedLifecycle: number): void {
  clearHandshakeTimeout();
  handshakeTimeout = globalThis.setTimeout(() => {
    handshakeTimeout = null;
    if (nativePort === port
      && lifecycleVersion === expectedLifecycle
      && secureChannel === null) {
      disconnectSecurePort(port);
    }
  }, HANDSHAKE_TIMEOUT_MS);
}

function clearHandshakeTimeout(): void {
  if (handshakeTimeout === null) return;
  globalThis.clearTimeout(handshakeTimeout);
  handshakeTimeout = null;
}

export function parseSessionOffer(value: unknown): InjectSessionOffer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).length !== 3
    || frame.protocol !== INJECT_PROVIDER_PROTOCOL
    || frame.type !== "session.offer"
    || !isCanonicalBase64Url32(frame.hostSigningPublicKey)) return null;
  return frame as unknown as InjectSessionOffer;
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

function isCanonicalBase64Url32(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
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
  if (nativePort !== port) return;
  // Dispose first so the asynchronous onDisconnect callback cannot schedule a
  // duplicate retry for the same failed session.
  disposeSecureSession(port);
  try {
    port.disconnect();
  } catch {
    // The channel is already disposed; retry remains owned by the alarm below.
  }
  scheduleNativeAgentReconnect(lifecycleVersion);
}

function disposeSecureSession(port?: chrome.runtime.Port): void {
  if (port !== undefined && nativePort !== port) return;
  clearHandshakeTimeout();
  secureChannel?.dispose();
  clientSession?.dispose();
  secureChannel = null;
  clientSession = null;
  nativePort = null;
}

async function getActivePage(): Promise<AgentTabState | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  return getPageById(tab.id);
}

export async function getPageById(tabId: number): Promise<AgentTabState | null> {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return null;
  try {
    const response = await settleWithin(
      chrome.tabs.sendMessage(
        tabId,
        { channel: TAB_URL_REQUEST_CHANNEL },
        { frameId: 0 },
      ),
      TAB_PROBE_TIMEOUT_MS,
    );
    return {
      id: tabId,
      page: isTabUrlResponse(response)
        ? { url: response.url, documentId: response.documentId }
        : null,
    };
  } catch {
    return { id: tabId, page: null };
  }
}

function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error("Agent tab probe timed out")),
      timeoutMs,
    );
    operation.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function sendStep(
  tabId: number,
  expectedDomain: string,
  documentId: string,
  step: AgentInjectFormStep,
  values: readonly AgentInjectFieldValue[],
): Promise<AgentInjectStepOutcome | null> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain, documentId, step, values },
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
