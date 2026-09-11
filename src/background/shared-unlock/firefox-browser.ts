import { FIREFOX_SHARED_UNLOCK_BRIDGE_PATH } from "../../shared/messaging/shared-unlock-firefox";
import type { SharedUnlockOperationFrame } from "../../shared/messaging/shared-unlock-operation";
import { randomBytes, toBase64Url } from "@palladin/crypto";
import { SHARED_UNLOCK_BROWSER_PORT, isSharedUnlockBrowserMessage, type SharedUnlockBrowserReady } from "../../shared/messaging/shared-unlock-browser";
import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { FirefoxSharedUnlockRoute, type FirefoxSharedUnlockBrowserApi } from "./firefox-route";

/** Runtime-owned routes. A source/receiver coordinator must add account/link authority. */
export function startFirefoxSharedUnlockBrowser(environments: readonly SharedUnlockEnvironment[],
  currentApiUrl: () => string, initialize: () => Promise<unknown> = async () => undefined,
  onReady?: (route: FirefoxSharedUnlockRoute) => void) {
  const active = new Map<number, FirefoxSharedUnlockRoute>();
  const connections = new Set<() => void>();
  const documents = new Map<() => void, { tabId: number; frameId: number }>();
  const navigating = new Map<number, Set<number>>();
  let stopped = false;
  let suspensions = 0;
  const browser: FirefoxSharedUnlockBrowserApi = {
    extensionId: chrome.runtime.id, bridgeUrl: chrome.runtime.getURL(FIREFOX_SHARED_UNLOCK_BRIDGE_PATH), currentApiUrl,
    getTab: tabId => chrome.tabs.get(tabId),
    getFrames: async tabId => (await chrome.webNavigation.getAllFrames({ tabId })) ?? [],
  };
  const retire = (tabId: number) => { active.get(tabId)?.close(); active.delete(tabId); };
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== SHARED_UNLOCK_BROWSER_PORT) return;
    // Bound pending handshakes as well as ready routes. No durable queue.
    if (stopped || suspensions > 0 || connections.size >= 64) {
      try { port.disconnect(); } catch { /* gone */ } return;
    }
    let route: FirefoxSharedUnlockRoute | null = null;
    let disconnected = false;
    let helloStarted = false;
    let ready = false;
    let receiving = false;
    const pendingOperations: SharedUnlockOperationFrame[] = [];
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      pendingOperations.length = 0;
      clearTimeout(timeout);
      connections.delete(disconnect);
      documents.delete(disconnect);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(disconnect);
      if (route && active.get(route.tabId) === route) active.delete(route.tabId);
      route?.close();
      try { port.disconnect(); } catch { /* gone */ }
    };
    const timeout = setTimeout(disconnect, 5000);
    const message = (raw: unknown) => {
      if (!isSharedUnlockBrowserMessage(raw)) { disconnect(); return; }
      if (ready && route && raw.type === "operation") {
        if (pendingOperations.length >= 4) { disconnect(); return; }
        pendingOperations.push(raw);
        if (!receiving) {
          receiving = true;
          const current = route;
          void (async () => {
            while (!disconnected && pendingOperations.length) {
              const frame = pendingOperations.shift()!;
              await current.verifyCurrent();
              if (disconnected || route !== current) return;
              current.receiveOperation(frame);
            }
          })().catch(disconnect).finally(() => { receiving = false; });
        }
        return;
      }
      if (helloStarted || raw.type !== "hello") { disconnect(); return; }
      helloStarted = true;
      void (async () => {
        await initialize();
        if (disconnected) return;
        const channelId = toBase64Url(await randomBytes(32));
        if (disconnected) return;
        const candidate = await FirefoxSharedUnlockRoute.accept(port, browser, environments, channelId, disconnect);
        if (disconnected) { candidate?.close(); return; }
        if (!candidate || navigating.get(candidate.tabId)?.has(0) || navigating.get(candidate.tabId)?.has(candidate.frameId)
          || raw.apiUrl !== candidate.apiUrl) { candidate?.close(); disconnect(); return; }
        route = candidate;
        retire(route.tabId);
        if (disconnected) return;
        active.set(route.tabId, route);
        await route.verifyCurrent();
        if (disconnected) return;
        const response: SharedUnlockBrowserReady = { type: "ready", protocol: SHARED_UNLOCK_BROWSER_PORT,
          apiUrl: route.apiUrl, webOrigin: route.webOrigin, extensionId: route.extensionId,
          webNonce: raw.webNonce, channelId, documentBinding: route.documentBinding };
        route.openOperations(raw.webNonce);
        ready = true;
        route.post(response);
        clearTimeout(timeout);
        onReady?.(route);
      })().catch(disconnect);
    };
    connections.add(disconnect);
    if (Number.isSafeInteger(port.sender?.tab?.id) && Number.isSafeInteger(port.sender?.frameId)) {
      documents.set(disconnect, { tabId: port.sender!.tab!.id!, frameId: port.sender!.frameId! });
    }
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
  };
  // Both the Web top document and our exact bridge document are authorities.
  // Track navigation even before a pending asynchronous handshake becomes ready.
  const beforeNavigate = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
    const affected = [...documents].filter(([, document]) => document.tabId === tabId && (frameId === 0 || document.frameId === frameId));
    if (!affected.length) return;
    const frames = navigating.get(tabId) ?? new Set<number>();
    frames.add(frameId); navigating.set(tabId, frames);
    for (const [disconnect] of affected) disconnect();
  };
  const finishNavigation = (tabId: number, frameId: number) => {
    const frames = navigating.get(tabId);
    frames?.delete(frameId);
    if (frames?.size === 0) navigating.delete(tabId);
  };
  const committed = ({ tabId, frameId, documentId }: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    finishNavigation(tabId, frameId);
    const route = active.get(tabId);
    if (route && ((frameId === 0 && route.documentId !== documentId)
      || (frameId === route.frameId && route.bridgeDocumentId !== documentId))) retire(tabId);
  };
  const removed = (tabId: number) => { navigating.delete(tabId); retire(tabId); };
  const replaced = ({ replacedTabId, tabId }: { replacedTabId: number; tabId: number }) => { removed(replacedTabId); removed(tabId); };
  const failed = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
    finishNavigation(tabId, frameId);
    if (frameId === 0 || active.get(tabId)?.frameId === frameId) retire(tabId);
  };
  chrome.runtime.onConnect.addListener(connect);
  chrome.webNavigation.onBeforeNavigate.addListener(beforeNavigate);
  chrome.webNavigation.onCommitted.addListener(committed);
  chrome.webNavigation.onErrorOccurred.addListener(failed);
  chrome.webNavigation.onTabReplaced.addListener(replaced);
  chrome.tabs.onRemoved.addListener(removed);
  return {
    /** Internal trusted routes only. Never expose this registry to page messages. */
    routes: () => [...active.values()],
    /** Server changes retire even pending routes before the first asynchronous step. */
    suspend() {
      suspensions += 1;
      for (const disconnect of [...connections]) disconnect();
      let resumed = false;
      return () => { if (!resumed) { resumed = true; suspensions -= 1; } };
    },
    close() {
      if (stopped) return;
      stopped = true;
      chrome.runtime.onConnect.removeListener(connect);
      chrome.webNavigation.onBeforeNavigate.removeListener(beforeNavigate);
      chrome.webNavigation.onCommitted.removeListener(committed);
      chrome.webNavigation.onErrorOccurred.removeListener(failed);
      chrome.webNavigation.onTabReplaced.removeListener(replaced);
      chrome.tabs.onRemoved.removeListener(removed);
      for (const disconnect of [...connections]) disconnect();
      active.clear(); navigating.clear(); documents.clear();
    },
  };
}
