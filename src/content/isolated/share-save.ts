import { SHARE_SAVE_CHANNEL, sharePageRequest, sharePageResponse } from '../../shared/messaging/share-save';

/** Page messages are untrusted; the worker independently verifies the browser sender. */
export function startShareSaveBridge(page: Window, send: (message: unknown) => Promise<unknown>,
  allowedOrigin: (origin: string) => boolean = origin =>
    __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__.some(item => item.webOrigin === origin)): () => void {
  const receive = (event: MessageEvent): void => {
    if (page !== page.top || event.source !== page || event.origin !== page.location.origin
      || !/^\/share\/[0-9a-f-]{36}$/.test(page.location.pathname)
      || !allowedOrigin(event.origin)) return;
    const parsed = sharePageRequest.safeParse(event.data);
    if (!parsed.success) return;
    if (parsed.data.type === 'prepare' && new TextEncoder().encode(JSON.stringify(parsed.data.snapshot)).length > 262_144) {
      page.postMessage({ channel: SHARE_SAVE_CHANNEL, type: 'response',
        requestId: parsed.data.requestId, status: 'unavailable' }, page.location.origin);
      return;
    }
    void send(parsed.data).then(response => {
      const valid = sharePageResponse.safeParse(response);
      if (valid.success && valid.data.requestId === parsed.data.requestId) {
        page.postMessage(valid.data, page.location.origin);
      }
    }).catch(() => {
      // A prepare may have reached the worker before the reply was lost. Let
      // the page deadline classify it as uncertain rather than rejected.
      if (parsed.data.type === 'prepare' || parsed.data.type === 'reconcile') return;
      page.postMessage({ channel: SHARE_SAVE_CHANNEL, type: 'response',
        requestId: parsed.data.requestId, status: 'unavailable' }, page.location.origin);
    });
  };
  page.addEventListener('message', receive);
  return () => page.removeEventListener('message', receive);
}
