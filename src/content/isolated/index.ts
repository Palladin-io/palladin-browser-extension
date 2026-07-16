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
  isBridgeMessage,
  isFillRequestMessage,
  validateInboundEnvelope,
  type FillOutcome,
} from "@shared/messaging";

import { performFill } from "./fill";

const sessionNonce = generateNonce();
const selfOrigin = window.location.origin;

const port = chrome.runtime.connect({ name: CONTENT_PORT });

// Fill requests arrive as a direct, tab-addressed runtime message from the
// worker (never the page). We perform the DOM write here in the isolated world
// and reply with the outcome. The secret value stays in this world — it is
// written into the page's inputs but is NEVER forwarded to the main-world script
// (see the Port relay below, which explicitly excludes fill traffic).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isFillRequestMessage(message)) return undefined;
  const outcome: FillOutcome = performFill(document, message.fields);
  sendResponse(outcome);
  return undefined;
});

// Worker -> main world: forward anything the worker sends down to the page's
// main world, re-wrapped as an isolated->main envelope.
port.onMessage.addListener((raw) => {
  if (!isBridgeMessage(raw)) return;
  window.postMessage(
    createEnvelope("isolated->main", sessionNonce, raw),
    selfOrigin,
  );
});

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

// Handshake: hand the session nonce to the main-world slot so it can talk back.
window.postMessage(
  createEnvelope("isolated->main", sessionNonce, {
    type: "bridge/hello",
    nonce: sessionNonce,
  }),
  selfOrigin,
);

// TODO(fill-engine): detect credential/password fields (language-independent
// heuristics: autocomplete, type=password, name/id) and drive the inline menu.
