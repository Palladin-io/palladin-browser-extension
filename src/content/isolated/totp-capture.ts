import { isCaptureNoticeIdentity, type CaptureNoticeIdentity } from '@shared/messaging/capture-notice';
import { TOTP_CAPTURE_CHANNEL, type TotpContentCommand } from '@shared/messaging/totp-capture';
import { capturedTotpIdentity, parseCapturedTotp, type CapturedTotpIdentityFields } from '@shared/totp-capture';
import type { TotpParams } from '@palladin/crypto';
import { detectTotpUris, scanTotpQr, hasVisibleTotpCanvas } from './totp-detection';
import { SecretCaptureNotice } from './secret-notice';
interface Options {
  send?(command: TotpContentCommand): Promise<unknown>;
  detect?(doc: Document): string[];
  notice?: { show(locked: boolean, identity?: CaptureNoticeIdentity): void; hide(): void; stop(): void; review?(documentId: string, kind: 'totp', captureId: string): Promise<boolean>; isOwnedSurface?(element: Element): boolean };
}
export function startTotpCapture(doc: Document, documentId: string, options: Options = {}) {
  const send = options.send ?? (command => chrome.runtime.sendMessage(command));
  const detect = options.detect ?? (document => [...new Set([...detectTotpUris(document), ...scanTotpQr(document)])]);
  let stopped = false, generation = 0, candidateId: string | null = null, dismissed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reviewingId: string | null = null;
  const notice = options.notice ?? new SecretCaptureNotice(doc, async action => {
    if (!candidateId) return;
    if (action === 'mute') {
      const result = await send({channel:TOTP_CAPTURE_CHANNEL,type:'mute',documentId,id:candidateId});
      if (!result || typeof result !== 'object' || !('status' in result) || !['dismissed','stale'].includes(String(result.status))) throw Error('Capture preference unavailable');
      dismissed = true; candidateId = null; notice.hide(); generation++;
    } else if (action === 'dismiss') { dismissed = true; candidateId = null; notice.hide(); generation++;
      await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'invalidate', documentId, sequence: generation });
    } else {
      const id = candidateId;
      if (await notice.review?.(documentId, 'totp', id)) reviewingId = id;
    }
  }, 'totp');
  function configurations() {
    const unique = new Map<string, { uri: string; params: TotpParams }>();
    for (const uri of detect(doc).slice(0, 16)) {
      const params = parseCapturedTotp(uri); if (params) unique.set(capturedTotpIdentity(params), { uri, params });
    }
    return [...unique.values()];
  }
  async function scan(manual = false): Promise<'found' | 'empty' | 'ambiguous'> {
    if (stopped || dismissed && !manual) return 'empty';
    if (manual) { dismissed = false; generation++; }
    const epoch = generation; const values = configurations();
    if (values.length !== 1) {
      candidateId = null; notice.hide();
      await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'invalidate', documentId, sequence: epoch }).catch(() => undefined);
      return values.length ? 'ambiguous' : 'empty';
    }
    const result = await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'observe', documentId, uri: values[0]!.uri, sequence: epoch, manual }).catch(() => null);
    if (stopped || generation !== epoch) return 'empty';
    if (result && typeof result === 'object' && 'status' in result && result.status === 'accepted' && 'id' in result && typeof result.id === 'string') {
      candidateId = result.id; if (!manual && candidateId !== reviewingId) notice.show(false, 'notice' in result && isCaptureNoticeIdentity(result.notice) ? result.notice : undefined); return 'found';
    }
    if (result && typeof result === 'object' && 'status' in result && result.status === 'dismissed') { dismissed = true; candidateId = null; notice.hide(); }
    return 'empty';
  }
  const schedule = (invalidate = true) => {
    generation++;
    if (invalidate) {
      void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'advance', documentId, sequence: generation }).catch(() => undefined);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void scan(); }, 350);
  };
  const relevant = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element && (!!element.closest('a,output,img,canvas') || !!element.querySelector('a[href^="otpauth:"],output,img,canvas'));
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList'
      ? [...record.addedNodes, ...record.removedNodes].some(relevant) || !!(record.target instanceof Element && record.target.closest('a,output,canvas'))
      : relevant(record.target))) schedule();
  });
  observer.observe(doc.body ?? doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'hidden', 'style', 'class', 'aria-hidden'] });
  const onLoad = () => schedule();
  doc.addEventListener('load', onLoad, true);
  schedule(false);
  const canvasTimer = setInterval(() => { if (!stopped && !dismissed && doc.visibilityState !== 'hidden' && hasVisibleTotpCanvas(doc)) { generation++; void scan(); } }, 5_000);
  return { refresh: () => scan(false), scan: () => scan(true), matches: (expected: CapturedTotpIdentityFields) => {
    const values = configurations(); return !stopped && values.length === 1 && capturedTotpIdentity(values[0]!.params) === capturedTotpIdentity(expected);
  }, isOwnedSurface: (element: Element) => notice.isOwnedSurface?.(element) ?? false, stop() { stopped = true; generation++; observer.disconnect(); clearInterval(canvasTimer); doc.removeEventListener('load', onLoad, true); if (timer) clearTimeout(timer); candidateId = null; notice.stop(); } };
}
