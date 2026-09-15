import type { SharedUnlockEnvironment } from "../shared/config/shared-unlock-environments";
import { isSharedUnlockBrowserMessage, SHARED_UNLOCK_BROWSER_PORT } from "../shared/messaging/shared-unlock-browser";
import { FIREFOX_SHARED_UNLOCK_CLOSED } from "../shared/messaging/shared-unlock-firefox";
import { FIREFOX_CURRENT_DOCUMENT, FIREFOX_DOCUMENT_BINDING } from "../shared/messaging/shared-unlock-firefox-document";

/** No keys or Identity tokens live here. This own-extension document forwards
 * only bounded protocol frames. The background independently authenticates its
 * browser sender and the current top/bridge document relationship. */
export function startFirefoxSharedUnlockBridge(owner: Window, environments: readonly SharedUnlockEnvironment[],
  runtime: Pick<typeof chrome.runtime, "connect" | "id" | "lastError" | "onMessage">) {
  let port: chrome.runtime.Port | null = null;
  let peer: { origin: string; apiUrl: string; webNonce: string } | null = null;
  let stopped = false;
  let ready = false;
  const marker = crypto.randomUUID();
  const currentDocument = (raw: unknown, sender: chrome.runtime.MessageSender, respond: (value: { marker: string }) => void) => {
    if (!stopped && sender.id === runtime.id && sender.tab === undefined && raw && typeof raw === "object"
      && !Array.isArray(raw) && Object.keys(raw).length === 1 && (raw as { type?: unknown }).type === FIREFOX_CURRENT_DOCUMENT) respond({ marker });
  };
  runtime.onMessage.addListener(currentDocument);
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    owner.removeEventListener("message", message);
    owner.removeEventListener("pagehide", close);
    runtime.onMessage.removeListener(currentDocument);
    const old = port; port = null;
    old?.onMessage.removeListener(receive);
    old?.onDisconnect.removeListener(disconnected);
    try { old?.disconnect(); } catch { /* removed */ }
    if (peer) owner.parent.postMessage({ type: FIREFOX_SHARED_UNLOCK_CLOSED }, peer.origin);
    peer = null;
  };
  const disconnected = () => { void runtime.lastError; close(); };
  const receive = (raw: unknown) => {
    if (stopped || !peer) return;
    if (!isSharedUnlockBrowserMessage(raw) || raw.type === "hello" || raw.apiUrl !== peer.apiUrl
      || raw.webNonce !== peer.webNonce || (ready ? raw.type !== "operation" : raw.type !== "ready")
      || (raw.type === "ready" && (raw.extensionId !== runtime.id || raw.webOrigin !== peer.origin))) {
      close(); return;
    }
    ready = true;
    clearTimeout(timeout);
    owner.parent.postMessage(raw, peer.origin);
  };
  const message = (event: MessageEvent<unknown>) => {
    if (stopped || owner.parent === owner || owner.parent !== owner.top || event.source !== owner.parent) return;
    // The exact origin (including port) comes from the browser, never the payload.
    if (!environments.some(item => item.webOrigin === event.origin)) return;
    const raw = event.data;
    if (!isSharedUnlockBrowserMessage(raw) || raw.type === "ready") { close(); return; }
    if (!peer) {
      if (raw.type !== "hello" || !environments.some(item => item.webOrigin === event.origin && item.apiUrl === raw.apiUrl)) {
        close(); return;
      }
      peer = { origin: event.origin, apiUrl: raw.apiUrl, webNonce: raw.webNonce };
      try {
        port = runtime.connect({ name: SHARED_UNLOCK_BROWSER_PORT });
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(disconnected);
        port.postMessage({ type: FIREFOX_DOCUMENT_BINDING, marker });
      } catch { close(); return; }
    } else if (!ready || raw.type !== "operation" || event.origin !== peer.origin || raw.apiUrl !== peer.apiUrl
      || raw.webNonce !== peer.webNonce) { close(); return; }
    try { port!.postMessage(raw); } catch { close(); }
  };
  const timeout = setTimeout(close, 5000);
  owner.addEventListener("message", message);
  owner.addEventListener("pagehide", close);
  return { close };
}
