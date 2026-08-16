/** Tracks the browser-issued documentId of the live top-frame content Port. */

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
