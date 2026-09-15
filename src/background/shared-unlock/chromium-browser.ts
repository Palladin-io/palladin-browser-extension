import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { ChromiumSharedUnlockRoute, type SharedUnlockBrowserApi } from "./chromium-route";
import { startExternalSharedUnlockBrowser } from "./external-browser";

/** Chromium retains its native active/outermost-frame authority. */
export function startChromiumSharedUnlockBrowser(environments: readonly SharedUnlockEnvironment[],
  currentApiUrl: () => string, initialize: () => Promise<unknown> = async () => undefined,
  onReady?: (route: ChromiumSharedUnlockRoute) => void) {
  const browser: SharedUnlockBrowserApi = {
    extensionId: chrome.runtime.id, currentApiUrl,
    getTab: tabId => chrome.tabs.get(tabId),
    getFrame: tabId => chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
  };
  return startExternalSharedUnlockBrowser({ native: chrome, initialize,
    tabReplacedEvent: chrome.webNavigation.onTabReplaced,
    accept: (port, channelId, onClosed) => ChromiumSharedUnlockRoute.accept(port, browser, environments, channelId, onClosed),
    matchesCommit: (route, details) => route.documentId === details.documentId && details.documentLifecycle === "active",
    ...(onReady ? { onReady } : {}),
  });
}
