/**
 * Isolated-world content script. It is the enforcement point of the bridge:
 *
 *   main world  <-- window.postMessage (validated) -->  [this]  <-- Port -->  service worker
 *
 * Runs in the extension's isolated world (its globals are hidden from the page).
 * On load it:
 *   1. mints a per-page-load session nonce,
 *   2. opens a Port to the service worker,
 *   3. hands the nonce to the main world via a `bridge/hello`,
 *   4. relays validated main-world messages to the worker, and worker messages
 *      back to the main world.
 *
 * Field detection and inline-menu fill are deliberately left as a TODO — they
 * arrive with the fill engine. No crypto and no secret handling live here; the
 * isolated world only ever receives a ready-to-use value after the worker has
 * cleared every gate.
 */

import {
  CONTENT_PORT,
  createEnvelope,
  generateNonce,
  isAgentInjectStepMessage,
  isAgentInjectTransitionMessage,
  isBridgeMessage,
  isFillRequestMessage,
  isTabUrlRequestMessage,
  validateInboundEnvelope,
  type AgentInjectStepMessage,
  type FillOutcome,
} from "@shared/messaging";
import { isCaptureFillRequestMessage } from "@shared/messaging/capture";

import { startPasswordCaptureDetection } from "./capture";
import { inspectAgentInjectTransition, performAgentInjectStep } from "./agent-inject";
import { performBoundFill } from "./fill";
import { createReconnectingWorkerPort } from "./worker-port";

const sessionNonce = generateNonce();
const documentId = generateNonce();
const selfOrigin = window.location.origin;

const port = createReconnectingWorkerPort(
  () => chrome.runtime.connect({ name: CONTENT_PORT }),
  (raw) => {
    if (!isBridgeMessage(raw)) return;
    window.postMessage(
      createEnvelope("isolated->main", sessionNonce, raw),
      selfOrigin,
    );
  },
  () => { void chrome.runtime.lastError; },
);
const passwordCapture = startPasswordCaptureDetection(
  document,
  () => window.location.href,
  documentId,
  (message) => {
    // Shape-only observation: candidate id + kind. No page value crosses.
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  },
  window.top === window,
);

// Fill requests arrive as a direct, tab-addressed runtime message from the
// worker (never the page). We perform the DOM write here in the isolated world
// and reply with the outcome. The secret value stays in this world — it is
// written into the page's inputs but is NEVER forwarded to the main-world script
// (see the Port relay below, which explicitly excludes fill traffic).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isTabUrlRequestMessage(message)) {
    sendResponse({ url: window.location.href, documentId });
    return undefined;
  }
  if (isCaptureFillRequestMessage(message)) {
    sendResponse(passwordCapture.controller.fill(message));
    return undefined;
  }
  if (isAgentInjectTransitionMessage(message)) {
    sendResponse(inspectAgentInjectTransition(
      document,
      message.selector,
      message.expectedDomain,
      () => window.location.href,
    ));
    return undefined;
  }
  if (isAgentInjectStepMessage(message)) {
    try {
      sendResponse(performAgentInjectStep(document, message, () => window.location.href));
    } catch {
      sendResponse({ ok: false, outcome: "provider-unavailable" });
    } finally {
      wipeStepValues(message);
    }
    return undefined;
  }
  if (!isFillRequestMessage(message)) return undefined;
  const outcome: FillOutcome = performBoundFill(
    document,
    message,
    window.location.href,
    documentId,
  );
  sendResponse(outcome);
  return undefined;
});

function wipeStepValues(message: AgentInjectStepMessage): void {
  for (const field of message.values) (field as { value: string }).value = "";
}

// Main world -> worker: accept only messages we can attribute to this frame and
// this page load, then forward the unwrapped payload to the worker.
window.addEventListener("message", (event: MessageEvent) => {
  const result = validateInboundEnvelope(event, {
    self: window,
    expectedOrigin: selfOrigin,
    expectedDirection: "main->isolated",
    expectedNonce: sessionNonce,
  });
  if (!result.ok) return;
  port.postMessage(result.message);
});

// Chrome closes extension Ports when a document enters BFCache. The document
// and content-script state survive, so restore a fresh worker registration when
// the same page returns instead of logging an unchecked runtime.lastError.
window.addEventListener("pageshow", (event: PageTransitionEvent) => {
  if (event.persisted) port.reconnect();
});

// Handshake: hand the session nonce to the main-world slot so it can talk back.
window.postMessage(
  createEnvelope("isolated->main", sessionNonce, {
    type: "bridge/hello",
    nonce: sessionNonce,
  }),
  selfOrigin,
);
