import type { SharedUnlockOperationFrame } from "../../shared/messaging/shared-unlock-operation";
import { randomBytes, toBase64Url } from "@palladin/crypto";
import { SHARED_UNLOCK_BROWSER_PORT, isSharedUnlockBrowserMessage, type SharedUnlockBrowserReady } from "../../shared/messaging/shared-unlock-browser";
import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { ChromiumSharedUnlockRoute, type SharedUnlockBrowserApi } from "./chromium-route";

/** Runtime-owned routes. A source/receiver coordinator must add account/link authority. */
export function startChromiumSharedUnlockBrowser(environments: readonly SharedUnlockEnvironment[],
  currentApiUrl: () => string, initialize: () => Promise<unknown> = async () => undefined,
  onReady?: (route: ChromiumSharedUnlockRoute) => void) {
  const active = new Map<number, ChromiumSharedUnlockRoute>();
  const connections = new Set<() => void>();
  const navigating = new Set<number>();
  let stopped = false;
  let suspensions = 0;
  const browser: SharedUnlockBrowserApi = {
    extensionId: chrome.runtime.id, currentApiUrl,
    getTab: tabId => chrome.tabs.get(tabId),
    getFrame: tabId => chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
  };
  const retire = (tabId: number) => { active.get(tabId)?.close(); active.delete(tabId); };
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== SHARED_UNLOCK_BROWSER_PORT) return;
    // Bound pending handshakes as well as ready routes. No durable queue.
    if (stopped || suspensions > 0 || connections.size >= 64) {
      try { port.disconnect(); } catch { /* gone */ } return;
    }
    let route: ChromiumSharedUnlockRoute | null = null;
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
        const candidate = ChromiumSharedUnlockRoute.accept(port, browser, environments, channelId, disconnect);
        if (!candidate || navigating.has(candidate.tabId) || raw.apiUrl !== candidate.apiUrl) { disconnect(); return; }
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
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
  };
  const beforeNavigate = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
    if (frameId === 0 && active.has(tabId)) { navigating.add(tabId); retire(tabId); }
  };
  const committed = ({ tabId, frameId, documentId, documentLifecycle }: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    if (frameId !== 0) return;
    navigating.delete(tabId);
    const route = active.get(tabId);
    if (route && (route.documentId !== documentId || documentLifecycle !== "active")) retire(tabId);
  };
  const removed = (tabId: number) => { navigating.delete(tabId); retire(tabId); };
  const replaced = ({ replacedTabId, tabId }: { replacedTabId: number; tabId: number }) => { removed(replacedTabId); removed(tabId); };
  const failed = ({ tabId, frameId }: { tabId: number; frameId: number }) => { if (frameId === 0) { navigating.delete(tabId); retire(tabId); } };
  chrome.runtime.onConnectExternal.addListener(connect);
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
      chrome.runtime.onConnectExternal.removeListener(connect);
      chrome.webNavigation.onBeforeNavigate.removeListener(beforeNavigate);
      chrome.webNavigation.onCommitted.removeListener(committed);
      chrome.webNavigation.onErrorOccurred.removeListener(failed);
      chrome.webNavigation.onTabReplaced.removeListener(replaced);
      chrome.tabs.onRemoved.removeListener(removed);
      for (const disconnect of [...connections]) disconnect();
      active.clear(); navigating.clear();
    },
  };
}
