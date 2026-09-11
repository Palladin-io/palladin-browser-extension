import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { startExternalSharedUnlockBrowser, type ExternalSharedUnlockBrowserApi } from "./external-browser";
import { SafariSharedUnlockRoute, type SafariSharedUnlockBrowserApi } from "./safari-route";

/** The Safari namespace supplies native IDs and direct external Ports. Missing
 * capabilities disable this channel without breaking independent manual unlock. */
export function startSafariSharedUnlockBrowser(environments: readonly SharedUnlockEnvironment[],
  currentApiUrl: () => string, initialize: () => Promise<unknown> = async () => undefined,
  onReady?: (route: SafariSharedUnlockRoute) => void) {
  const native = (globalThis as typeof globalThis & { browser?: ExternalSharedUnlockBrowserApi }).browser;
  if (!native || typeof native.runtime?.getURL !== "function" || typeof native.tabs?.get !== "function"
    || typeof native.webNavigation?.getFrame !== "function") return null;
  const events = [native.runtime.onConnectExternal, native.webNavigation.onBeforeNavigate,
    native.webNavigation.onCommitted, native.webNavigation.onErrorOccurred, native.webNavigation.onTabReplaced, native.tabs.onRemoved];
  if (events.some(event => typeof event?.addListener !== "function" || typeof event?.removeListener !== "function")) return null;
  const browser: SafariSharedUnlockBrowserApi = {
    extensionId: native.runtime.id, extensionUrl: () => native.runtime.getURL(""), currentApiUrl,
    getTab: tabId => native.tabs.get(tabId),
    getFrame: tabId => native.webNavigation.getFrame({ tabId, frameId: 0 }),
  };
  return startExternalSharedUnlockBrowser({ native, initialize,
    accept: (port, channelId, onClosed) => SafariSharedUnlockRoute.accept(port, browser, environments, channelId, onClosed),
    matchesCommit: (route, details) => route.documentId === details.documentId
      && (details.documentLifecycle === undefined || details.documentLifecycle === "active"),
    ...(onReady ? { onReady } : {}),
  });
}
