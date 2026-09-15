import { TAB_URL_REQUEST_CHANNEL } from "@shared/messaging";
import { extensionBuildTarget } from "@shared/config/build-target";
import { FirefoxLegacyDocuments } from "./firefox-legacy-documents";

export const legacyFirefoxDocuments = extensionBuildTarget === "firefox" ? new FirefoxLegacyDocuments({
  extensionId: chrome.runtime.id,
  getBrowserInfo: async () => {
    const runtime = chrome.runtime as typeof chrome.runtime & { getBrowserInfo?: () => Promise<{ name: string; version: string }> };
    return runtime.getBrowserInfo ? runtime.getBrowserInfo() : null;
  },
  getTab: tabId => chrome.tabs.get(tabId),
  probeCurrent: tabId => chrome.tabs.sendMessage(tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { frameId: 0 }),
}) : null;

if (legacyFirefoxDocuments) {
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" || change.url !== undefined) legacyFirefoxDocuments.retire(tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => legacyFirefoxDocuments.retire(tabId));
  chrome.tabs.onReplaced?.addListener((added, removed) => { legacyFirefoxDocuments.retire(added); legacyFirefoxDocuments.retire(removed); });
}
