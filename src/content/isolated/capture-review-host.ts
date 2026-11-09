import type { InlineCaptureKind } from '@shared/messaging/inline-capture-review';
import { createClosedSurface } from './closed-surface';

interface Gesture { x: number; y: number; keyboard: boolean; at: number }
interface Surface { host: HTMLElement; shadow: ShadowRoot; frame: HTMLIFrameElement; modal?: HTMLDialogElement }
export interface CaptureReviewPlacement {
  left: number; top: number; width: number; height: number;
  onReady?(): void;
}
const TRANSITION_MS = 320;
const INTERFERENCE_LIMIT = 3;
const hasPopover = () => typeof HTMLElement.prototype.showPopover === 'function';
const topLayerSelector = () => hasPopover() ? ':popover-open, :modal' : ':modal';
const ownedLayerOpen = ({ host, modal }: Surface) => modal ? modal.matches(':modal') : hasPopover() && host.matches(':popover-open');

export function captureFrameVisible(doc: Document, surface: Surface, gesture?: Gesture): boolean {
  const { host, shadow, frame, modal } = surface;
  const win = doc.defaultView;
  if (!win || doc.visibilityState !== 'visible' || host.parentNode !== doc.documentElement
    || shadow.host !== host || frame.parentNode !== (modal ?? shadow)
    || modal && modal.parentNode !== shadow || !ownedLayerOpen(surface)) return false;
  for (const element of [host, ...(modal ? [modal] : []), frame]) {
    const style = win.getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible'
      || style.opacity !== '' && Number(style.opacity) !== 1
      || style.transform && style.transform !== 'none' || style.filter && style.filter !== 'none'
      || style.clipPath && style.clipPath !== 'none' || style.clip && style.clip !== 'auto'
      || style.perspective && style.perspective !== 'none'
      || style.maskImage && style.maskImage !== 'none' || style.mixBlendMode && style.mixBlendMode !== 'normal'
      || style.zoom && !['1', 'normal'].includes(style.zoom)) return false;
  }
  const rect = frame.getBoundingClientRect();
  if (rect.width < 280 || rect.height < 100 || rect.left < 0 || rect.top < 0
    || rect.right > win.innerWidth || rect.bottom > win.innerHeight) return false;
  const hit = (x: number, y: number) => doc.elementFromPoint(x, y) === host && shadow.elementFromPoint(x, y) === frame;
  if (![[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8],
    [rect.left + 8, rect.bottom - 8], [rect.right - 8, rect.bottom - 8],
    [rect.left + rect.width / 2, rect.top + rect.height / 2]].every(([x, y]) => hit(x!, y!))) return false;
  if (!gesture) return true;
  if (gesture.keyboard) return doc.activeElement === host && shadow.activeElement === frame;
  return Number.isFinite(gesture.x) && Number.isFinite(gesture.y) && gesture.x >= 0 && gesture.y >= 0
    && gesture.x < rect.width && gesture.y < rect.height && hit(rect.left + gesture.x, rect.top + gesture.y);
}

/** Event-based interference detection reduces known attacks; it is not browser
 * attestation of the pixels presented at the exact time of a user action. */
export function createCaptureReviewGuard(doc: Document, surface: Surface, onTamper: () => void) {
  const win = doc.defaultView!;
  const { host, modal } = surface;
  const ownedMutation = (record: MutationRecord) => record.target === host || record.target === modal || [...record.removedNodes].some(node => node === host || node === modal);
  const initiallyOpen = new Set(doc.querySelectorAll(topLayerSelector()));
  const above = new Set<Element>();
  let poisonedUntil = 0, interference = 0, stopped = false;
  const fail = () => { if (!stopped) { stop(); onTamper(); } };
  const poison = (element: Element) => {
    if (above.has(element)) return;
    above.add(element); poisonedUntil = win.performance.now() + TRANSITION_MS;
    if (++interference >= INTERFERENCE_LIMIT) fail();
  };
  const toggle = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || (target === host || target === modal)
      || modal && target.tagName === 'DIALOG'
      || !(target.hasAttribute('popover') || target.tagName === 'DIALOG')) return;
    const state = (event as ToggleEvent).newState;
    if (state === 'open') poison(target);
    else if (state === 'closed') {
      above.delete(target); initiallyOpen.delete(target);
      poisonedUntil = win.performance.now() + TRANSITION_MS;
    }
  };
  const inspectMutations = (records: MutationRecord[]) => {
    if (records.some(ownedMutation)) { fail(); return false; }
    // Safari 16.4 has modal dialogs but no dialog toggle events. Remember even
    // an open/close pair completed before the next action's visibility check.
    if (modal) for (const record of records) {
      if (record.type !== 'attributes' || record.attributeName !== 'open'
        || !(record.target instanceof HTMLDialogElement) || record.target === modal) continue;
      if (record.oldValue === null) poison(record.target);
      else { above.delete(record.target); initiallyOpen.delete(record.target); poisonedUntil = win.performance.now() + TRANSITION_MS; }
    }
    return !stopped;
  };
  const observer = new MutationObserver(inspectMutations);
  const observe = () => {
    observer.observe(host, { attributes: true });
    if (modal) { observer.observe(modal, { attributes: true }); observer.observe(surface.shadow, { childList: true }); }
    observer.observe(doc.documentElement, { childList: true, subtree: true, ...(modal ? { attributes: true, attributeFilter: ['open'], attributeOldValue: true } : {}) });
  };
  function stop() {
    stopped = true; observer.disconnect();
    doc.removeEventListener('beforetoggle', toggle, true); doc.removeEventListener('toggle', toggle, true);
  }
  observe();
  doc.addEventListener('beforetoggle', toggle, true); doc.addEventListener('toggle', toggle, true);
  return {
    attest(gesture?: Gesture) {
      if (stopped) return false;
      if (!inspectMutations(observer.takeRecords())) return false;
      if (host.parentNode !== doc.documentElement || !ownedLayerOpen(surface)) { fail(); return false; }
      for (const element of doc.querySelectorAll(topLayerSelector())) {
        if (element !== host && element !== modal && !initiallyOpen.has(element)) poison(element);
      }
      for (const element of above) if (!element.isConnected || !element.matches(topLayerSelector())) above.delete(element);
      return !stopped && above.size === 0 && win.performance.now() >= poisonedUntil && captureFrameVisible(doc, surface, gesture);
    },
    resize(height: number) {
      if (stopped || !inspectMutations(observer.takeRecords())) { fail(); return; }
      observer.disconnect();
      host.style.setProperty('height', `${height}px`, 'important');
      modal?.style.setProperty('height', `${height}px`, 'important');
      observe();
    },
    stop,
  };
}

let closeCurrent: (() => void) | undefined;
/** The caller invokes this from its existing trusted Review action. Only ready
 * replaces the old notice; a failed initialization leaves that notice intact. */
export async function openInlineCaptureReview(doc: Document, documentId: string, kind: InlineCaptureKind,
  captureId: string, initial?: CaptureReviewPlacement): Promise<boolean> {
  const win = doc.defaultView;
  if (!win || win.top !== win || doc.location.protocol !== 'https:' || !hasPopover() && typeof HTMLDialogElement.prototype.showModal !== 'function') return false;
  closeCurrent?.();
  const { host, shadow } = createClosedSurface(doc, 'palladin-capture');
  const modal = hasPopover() ? undefined : doc.createElement('dialog');
  const frame = doc.createElement('iframe');
  const surface: Surface = { host, shadow, frame, ...(modal ? { modal } : {}) };
  const frameUrl = new URL(chrome.runtime.getURL('src/capture-review/index.html'));
  const targetOrigin = frameUrl.origin === 'null' ? `${frameUrl.protocol}//${frameUrl.host}` : frameUrl.origin;
  frame.setAttribute('title', 'Palladin');
  frame.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent;';
  const width = Math.min(initial?.width ?? 420, win.innerWidth - 32);
  const right = Math.max(16, Math.min(initial ? win.innerWidth - initial.left - initial.width : 16, win.innerWidth - width - 16));
  const top = Math.max(16, Math.min(initial?.top ?? 16, win.innerHeight - 132));
  const height = Math.max(100, Math.min(initial?.height ?? 200, win.innerHeight - top - 16));
  for (const [property, value] of Object.entries({ top: `${top}px`, right: `${right}px`, left: 'auto', bottom: 'auto',
    margin: '0', padding: '0', border: '0', width: `${width}px`, height: `${height}px`,
    background: 'transparent', 'pointer-events': 'auto', 'border-radius': '12px', overflow: 'hidden', 'box-shadow': '0 18px 45px #0003',
    transition: win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'none' : `height ${TRANSITION_MS}ms ease`,
  })) host.style.setProperty(property, value, 'important');
  if (modal) {
    modal.style.cssText = host.style.cssText;
    for (const [property, value] of Object.entries({ display: 'block', 'max-width': 'none', 'max-height': 'none', background: 'transparent' })) modal.style.setProperty(property, value, 'important');
  }
  const style = doc.createElement('style');
  style.textContent = ':host::before,:host::after,:host::backdrop,dialog::before,dialog::after,dialog::backdrop{content:none!important;display:none!important;filter:none!important;backdrop-filter:none!important;pointer-events:none!important}@media(prefers-reduced-motion:reduce){:host{transition:none!important}}';
  if (modal) { modal.append(frame); shadow.append(style, modal); }
  else { host.setAttribute('popover', 'manual'); shadow.append(style, frame); }
  let owner: chrome.runtime.Port;
  try { owner = chrome.runtime.connect({ name: 'palladin.inline-capture-review.owner.v1' }); }
  catch { return false; }
  return new Promise<boolean>(resolve => {
    let closed = false, ready = false, loaded = false, booted = false, capability: string | undefined;
    let pendingHeight: number | undefined;
    let guard: ReturnType<typeof createCaptureReviewGuard> | undefined;
    const channel = new MessageChannel();
    const started = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true; guard?.stop(); clearTimeout(timeout); clearInterval(watchdog);
      channel.port1.close(); channel.port2.close();
      try { owner.disconnect(); } catch { /* Worker may already have disconnected. */ }
      modal?.removeEventListener('cancel', cancel); modal?.removeEventListener('close', close);
      if (modal?.open) modal.close();
      host.remove(); doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('pagehide', close);
      win.removeEventListener('resize', close);
      if (closeCurrent === close) closeCurrent = undefined;
      if (!ready) resolve(false);
    };
    const cancel = (event: Event) => { event.preventDefault(); close(); };
    modal?.addEventListener('cancel', cancel); modal?.addEventListener('close', close);
    const visibility = () => { if (doc.visibilityState !== 'visible') close(); };
    const boot = () => {
      if (closed || !loaded || booted || !capability || !frame.contentWindow) return;
      booted = true;
      frame.contentWindow.postMessage({ channel: 'palladin.inline-capture-review.boot.v1', capability, kind }, targetOrigin, [channel.port2]);
      capability = undefined;
    };
    frame.addEventListener('load', () => {
      if (loaded) { close(); return; }
      loaded = true; boot();
    });
    channel.port1.onmessage = event => {
      const data: unknown = event.data;
      if (closed || !data || typeof data !== 'object' || !('type' in data)) return;
      if (data.type === 'binding-challenge' && 'requestId' in data && typeof data.requestId === 'string'
        && 'nonce' in data && typeof data.nonce === 'string' && frame.contentWindow && frame.src === frameUrl.href
        && guard?.attest()) {
        owner.postMessage({ type: 'binding-proof', requestId: data.requestId, nonce: data.nonce });
      } else if (data.type === 'ready' && !ready) {
        if (!guard?.attest()) { close(); return; }
        ready = true; clearTimeout(timeout);
        timeout = setTimeout(close, Math.max(0, 180_000 - (Date.now() - started)));
        initial?.onReady?.();
        if (pendingHeight !== undefined) guard.resize(pendingHeight);
        resolve(true);
      } else if (data.type === 'close' || data.type === 'failed') close();
      else if (data.type === 'resize' && 'height' in data && typeof data.height === 'number' && Number.isFinite(data.height)) {
        pendingHeight = Math.max(100, Math.min(Math.ceil(data.height), win.innerHeight - top - 16));
        if (ready) guard?.resize(pendingHeight);
      }
    };
    owner.onMessage.addListener((raw: unknown) => {
      if (closed || !raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'minted') {
        if (!('capability' in raw) || typeof raw.capability !== 'string') { close(); return; }
        capability = raw.capability; boot();
      } else if (raw.type === 'attest' && 'requestId' in raw && typeof raw.requestId === 'string') {
        const gesture = 'gesture' in raw ? raw.gesture as Gesture : undefined;
        owner.postMessage({ type: 'attested', requestId: raw.requestId, ok: frame.src === frameUrl.href && !!guard?.attest(gesture) });
      } else if (raw.type === 'invalidated') close();
    });
    owner.onDisconnect.addListener(close);
    closeCurrent = close;
    doc.addEventListener('visibilitychange', visibility); win.addEventListener('pagehide', close); win.addEventListener('resize', close);
    timeout = setTimeout(close, 8000);
    try {
      frame.src = frameUrl.href; doc.documentElement.append(host); if (modal) modal.showModal(); else host.showPopover();
      guard = createCaptureReviewGuard(doc, surface, close);
      watchdog = setInterval(() => {
        if (host.parentNode !== doc.documentElement || !ownedLayerOpen(surface) || frame.src !== frameUrl.href) close();
      }, 250);
      owner.postMessage({ type: 'mint', kind, captureId, documentId });
    } catch { close(); }
  });
}
