/**
 * Main-world content script. This runs in the PAGE's JavaScript context — it
 * shares globals with the site, so it is treated as untrusted. Its only job is
 * to be the future slot for the WebAuthn interceptor (CVT-362) and to carry
 * messages to the isolated world through the validated window bridge.
 *
 * It cannot reach `chrome.*` APIs and never touches secrets. The isolated world
 * re-validates everything this script sends (origin + source + nonce + type),
 * and the service worker gates every security-sensitive action, so a hostile
 * page script sharing this context cannot escalate through here.
 */

import {
  createEnvelope,
  validateInboundEnvelope,
} from "@shared/messaging";

const selfOrigin = window.location.origin;

// Pinned once the isolated world completes the handshake; until then we accept
// the bootstrap `bridge/hello` with no prior nonce (origin + source still gate).
let sessionNonce: string | null = null;

window.addEventListener("message", (event: MessageEvent) => {
  const result = validateInboundEnvelope(event, {
    self: window,
    expectedOrigin: selfOrigin,
    expectedDirection: "isolated->main",
    expectedNonce: sessionNonce,
  });
  if (!result.ok) return;

  const message = result.message;
  if (message.type === "bridge/hello") {
    sessionNonce = message.nonce;
    sendToIsolated({ type: "bridge/ready" });
  }
  // Other inbound messages are handled by future fulfillment strategies.
});

function sendToIsolated(payload: Parameters<typeof createEnvelope>[2]): void {
  if (sessionNonce === null) return;
  window.postMessage(
    createEnvelope("main->isolated", sessionNonce, payload),
    selfOrigin,
  );
}

// TODO(passkeys, CVT-362): intercept navigator.credentials.get/create here and
// forward a `webauthn/observed` message. Left as an empty slot on purpose — the
// bridge above is the plumbing that strategy will use.
