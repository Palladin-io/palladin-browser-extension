import type { SharedUnlockOperationFrame } from "../../shared/messaging/shared-unlock-operation";
import { randomBytes, toBase64Url } from "@palladin/crypto";
import { SHARED_UNLOCK_BROWSER_PORT, isSharedUnlockBrowserMessage, type SharedUnlockBrowserReady } from "../../shared/messaging/shared-unlock-browser";
import type { SharedUnlockBrowserRoute } from "./browser-route";

export type ExternalSharedUnlockBrowserApi = Pick<typeof chrome, "runtime" | "tabs" | "webNavigation">;
type DocumentRoute = SharedUnlockBrowserRoute & { readonly tabId: number; readonly documentId: string };
interface ExternalBrowserOptions<Route extends DocumentRoute> {
  readonly native: ExternalSharedUnlockBrowserApi;
  initialize(): Promise<unknown>;
  accept(port: chrome.runtime.Port, channelId: string, onClosed: () => void): Route | null;
  matchesCommit(route: Route, details: chrome.webNavigation.WebNavigationFramedCallbackDetails): boolean;
  tabReplacedEvent?: chrome.webNavigation.WebNavigationEvent<chrome.webNavigation.WebNavigationReplacementCallbackDetails>;
  onReady?(route: Route): void;
}

/** Bounded external-Port mechanics; each platform supplies its own authority. */
export function startExternalSharedUnlockBrowser<Route extends DocumentRoute>(options: ExternalBrowserOptions<Route>) {
  const { native, initialize, onReady } = options;
  const active = new Map<number, Route>();
  const connections = new Set<() => void>();
  const documents = new Map<() => void, { tabId: number; documentId: string | undefined }>();
  const navigating = new Set<number>();
  let stopped = false;
  let suspensions = 0;
  const retire = (tabId: number) => { active.get(tabId)?.close(); active.delete(tabId); };
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== SHARED_UNLOCK_BROWSER_PORT) return;
    // Bound pending handshakes as well as ready routes. No durable queue.
    if (stopped || suspensions > 0 || connections.size >= 64) {
      try { port.disconnect(); } catch { /* gone */ } return;
    }
    let route: Route | null = null;
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
      if (route) route.close();
      else { try { port.disconnect(); } catch { /* gone */ } }
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
        const candidate = options.accept(port, channelId, disconnect);
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
    if (Number.isSafeInteger(port.sender?.tab?.id)) {
      documents.set(disconnect, { tabId: port.sender!.tab!.id!, documentId: port.sender?.documentId });
    }
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
  };
  const beforeNavigate = ({ tabId, frameId }: { tabId: number; frameId: number }) => {
    if (frameId !== 0) return;
    const affected = [...documents].filter(([, document]) => document.tabId === tabId);
    if (!affected.length) return;
    navigating.add(tabId);
    for (const [disconnect] of affected) disconnect();
    retire(tabId);
  };
  const committed = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    const { tabId, frameId, documentId } = details;
    if (frameId !== 0) return;
    navigating.delete(tabId);
    for (const [disconnect, document] of [...documents]) {
      if (document.tabId === tabId && document.documentId !== documentId) disconnect();
    }
    const route = active.get(tabId);
    if (route && !options.matchesCommit(route, details)) retire(tabId);
  };
  const removed = (tabId: number) => {
    for (const [disconnect, document] of [...documents]) if (document.tabId === tabId) disconnect();
    navigating.delete(tabId); retire(tabId);
  };
  const replaced = ({ replacedTabId, tabId }: { replacedTabId: number; tabId: number }) => { removed(replacedTabId); removed(tabId); };
  const failed = ({ tabId, frameId }: { tabId: number; frameId: number }) => { if (frameId === 0) removed(tabId); };
  native.runtime.onConnectExternal.addListener(connect);
  native.webNavigation.onBeforeNavigate.addListener(beforeNavigate);
  native.webNavigation.onCommitted.addListener(committed);
  native.webNavigation.onErrorOccurred.addListener(failed);
  options.tabReplacedEvent?.addListener(replaced);
  native.tabs.onRemoved.addListener(removed);
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
      native.runtime.onConnectExternal.removeListener(connect);
      native.webNavigation.onBeforeNavigate.removeListener(beforeNavigate);
      native.webNavigation.onCommitted.removeListener(committed);
      native.webNavigation.onErrorOccurred.removeListener(failed);
      options.tabReplacedEvent?.removeListener(replaced);
      native.tabs.onRemoved.removeListener(removed);
      for (const disconnect of [...connections]) disconnect();
      active.clear(); navigating.clear(); documents.clear();
    },
  };
}
