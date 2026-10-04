import type { Connection } from '../../shared/config/connection';
import type { ShareSource } from './coordinator';

export function shareSource(sender: chrome.runtime.MessageSender, runtimeId: string,
  currentDocument: (tabId: number) => string | null, active: Connection | undefined): ShareSource | null {
  if (sender.id !== runtimeId || sender.frameId !== 0
    || typeof sender.tab?.id !== 'number' || sender.tab.incognito
    || typeof sender.documentId !== 'string' || !sender.documentId
    || currentDocument(sender.tab.id) !== sender.documentId || !sender.url) return null;
  try {
    const url = new URL(sender.url);
    if (!/^\/share\/[0-9a-f-]{36}$/.test(url.pathname)) return null;
    const environment = active && new URL(active.webUrl).origin === url.origin
      ? { webOrigin: url.origin, apiUrl: active.apiUrl } : null;
    if (!environment || sender.origin !== environment.webOrigin) return null;
    return { tabId: sender.tab.id, documentId: sender.documentId,
      url: sender.url, webOrigin: environment.webOrigin, apiUrl: environment.apiUrl };
  } catch { return null; }
}
