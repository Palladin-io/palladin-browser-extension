import { TOTP_CAPTURE_CHANNEL, type TotpContentCommand } from '@shared/messaging/totp-capture';
import { detectTotpUris, scanTotpQr } from './totp-detection';
import { SecretCaptureNotice } from './secret-notice';
interface Options {
  send?(command: TotpContentCommand): Promise<unknown>;
  detect?(doc: Document): string[];
  notice?: { show(locked: boolean): void; hide(): void; stop(): void; isOwnedSurface?(element: Element): boolean };
}
export function startTotpCapture(doc: Document, documentId: string, options: Options = {}) {
  const send = options.send ?? (command => chrome.runtime.sendMessage(command));
  const detect = options.detect ?? (document => [...new Set([...detectTotpUris(document), ...scanTotpQr(document)])]);
  let stopped = false, generation = 0, candidateId: string | null = null, dismissed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notice = options.notice ?? new SecretCaptureNotice(doc, async action => {
    if (!candidateId) return;
    if (action === 'dismiss') { dismissed = true; candidateId = null; notice.hide(); generation++;
      await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'invalidate', documentId, sequence: generation });
    } else await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'open', documentId, id: candidateId });
  }, 'totp');
  async function scan(manual = false): Promise<'found' | 'empty' | 'ambiguous'> {
    if (stopped || dismissed && !manual) return 'empty';
    if (manual) { dismissed = false; generation++; }
    const epoch = generation; const values = [...new Set(detect(doc))];
    if (values.length !== 1) {
      candidateId = null; notice.hide();
      await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'invalidate', documentId, sequence: epoch }).catch(() => undefined);
      return values.length ? 'ambiguous' : 'empty';
    }
    const result = await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'observe', documentId, uri: values[0]!, sequence: epoch }).catch(() => null);
    if (stopped || generation !== epoch) return 'empty';
    if (result && typeof result === 'object' && 'status' in result && result.status === 'accepted' && 'id' in result && typeof result.id === 'string') {
      candidateId = result.id; if (!manual) notice.show(false); return 'found';
    }
    return 'empty';
  }
  const schedule = (invalidate = true) => {
    generation++;
    if (invalidate) {
      candidateId = null; notice.hide();
      void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'invalidate', documentId, sequence: generation }).catch(() => undefined);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void scan(); }, 350);
  };
  const relevant = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element && (!!element.closest('a,output,img,canvas') || !!element.querySelector('a[href^="otpauth:"],output,img,canvas'));
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => relevant(record.target) || [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
  });
  observer.observe(doc.body ?? doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'hidden', 'style'] });
  const onLoad = () => schedule();
  doc.addEventListener('load', onLoad, true);
  schedule(false);
  return { scan: () => scan(true), isOwnedSurface: (element: Element) => notice.isOwnedSurface?.(element) ?? false, stop() { stopped = true; generation++; observer.disconnect(); doc.removeEventListener('load', onLoad, true); if (timer) clearTimeout(timer); candidateId = null; notice.stop(); } };
}
