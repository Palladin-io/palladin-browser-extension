/** Tracks the browser-issued documentId of the live top-frame content Port. */
import type { ShareSource } from './share-save/coordinator';

const topFrameDocuments = new Map<number, string>();

export function registerTopFrameDocument(
  port: chrome.runtime.Port,
  extensionId: string,
): (() => void) | null {
  const sender = port.sender;
  if (sender?.id !== extensionId
    || sender.frameId !== 0
    || typeof sender.tab?.id !== "number"
    || typeof sender.documentId !== "string"
    || sender.documentId.length === 0) return null;
  const tabId = sender.tab.id;
  const documentId = sender.documentId;
  topFrameDocuments.set(tabId, documentId);
  return () => {
    if (topFrameDocuments.get(tabId) === documentId) topFrameDocuments.delete(tabId);
  };
}

export function browserDocumentIdForTab(tabId: number): string | null {
  return topFrameDocuments.get(tabId) ?? null;
}

export async function verifyLiveShareDocument(
  source: ShareSource,
  requestUrl: () => Promise<unknown>,
  parseUrl: (value: unknown) => value is { url: string },
): Promise<boolean> {
  if (browserDocumentIdForTab(source.tabId) !== source.documentId) return false;
  try {
    const live = await requestUrl();
    // An awaited browser message may complete after a same-URL navigation.
    if (browserDocumentIdForTab(source.tabId) !== source.documentId || !parseUrl(live)) return false;
    const url = new URL(live.url);
    return url.origin === source.webOrigin && url.pathname === new URL(source.url).pathname;
  } catch { return false; }
}
