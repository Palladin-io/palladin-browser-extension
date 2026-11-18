// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/"}
import { afterEach, expect, it, vi } from 'vitest';
import { openInlineCaptureReview } from './capture-review-host';

class PrivateChannel {
  static current: PrivateChannel;
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() };
  port2 = { close: vi.fn() };
  constructor() { PrivateChannel.current = this; }
  receive(data: unknown) { this.port1.onmessage?.({ data }); }
}
function setup(reduced = false, modalFallback = false) {
  const listeners: Array<(raw: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  const messages: unknown[] = [];
  const owner = {
    postMessage: (message: unknown) => messages.push(message), disconnect: vi.fn(),
    onMessage: { addListener: (fn: (raw: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn) },
  };
  const postMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `moz-extension://synthetic-extension/${path}`, connect: () => owner } });
  vi.stubGlobal('MessageChannel', PrivateChannel);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  expect(document.location.protocol).toBe('https:');
  const opened = new WeakSet<Element>();
  const queryAll = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => (selector === ':popover-open, :modal' || selector === ':modal') ? [] as unknown as NodeListOf<Element> : queryAll(selector));
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: function(this: HTMLElement) { opened.add(this); } });
  if (modalFallback) delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; opened.add(this); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; opened.delete(this); } });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function(this: Element, selector: string) {
    if (selector === ':popover-open' || selector === ':modal') return opened.has(this);
    return matches.call(this, selector);
  });
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({ postMessage } as unknown as Window);
  vi.spyOn(HTMLIFrameElement.prototype, 'getBoundingClientRect').mockReturnValue({left:588,top:16,right:1008,bottom:216,width:420,height:200} as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('palladin-capture') });
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function(this: Element, init: ShadowRootInit) {
    const shadow = attach.call(this, init);
    Object.defineProperty(shadow, 'elementFromPoint', { configurable: true, value: () => shadow.querySelector('iframe') });
    return shadow;
  });
  return { messages, owner, postMessage, emit: (raw: unknown) => listeners.forEach(fn => fn(raw)),
    disconnect: () => disconnects.forEach(fn => fn()),
    frame: () => document.querySelector('palladin-capture')!,
  };
}
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  document.querySelectorAll('palladin-capture').forEach(host => host.remove());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
});

it('preserves the notice until ready, boots to the runtime origin, and relays only private binding challenges', async () => {
  const f = setup(); const onReady = vi.fn();
  const pending = openInlineCaptureReview(document, 'document', 'login', 'capture', { left:588,top:16,width:420,height:200,onReady });
  const host = f.frame() as HTMLElement;
  expect(host.style.height).toBe('200px'); expect(host.style.right).toBe('16px');
  expect(host.style.transition).toBe('height 320ms ease'); expect(host.shadowRoot).toBeNull();
  expect(f.messages).toContainEqual({ type:'mint', kind:'login', captureId:'capture', documentId:'document' });
  // Access the isolated frame through the attachShadow spy, not through host DOM.
  const shadow = vi.mocked(Element.prototype.attachShadow).mock.results[0]!.value as ShadowRoot;
  shadow.querySelector('iframe')!.dispatchEvent(new Event('load'));
  f.emit({ type:'minted', capability:'a'.repeat(64) });
  expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind:'login' }), 'moz-extension://synthetic-extension', [PrivateChannel.current.port2]);
  expect(onReady).not.toHaveBeenCalled();
  // Owner-channel requests are never reflected as ownership proof.
  f.emit({ type:'binding-challenge', requestId:'wrong', nonce:'wrong' });
  expect(f.messages).not.toContainEqual(expect.objectContaining({type:'binding-proof'}));
  PrivateChannel.current.receive({ type:'binding-challenge', requestId:'request', nonce:'private-proof' });
  expect(f.messages).toContainEqual({ type:'binding-proof', requestId:'request', nonce:'private-proof' });
  PrivateChannel.current.receive({ type:'ready' });
  await expect(pending).resolves.toBe(true); expect(onReady).toHaveBeenCalledOnce();
  PrivateChannel.current.receive({ type:'resize', height:500 }); expect(host.style.height).toBe('500px');
  PrivateChannel.current.receive({ type:'ready' }); expect(onReady).toHaveBeenCalledOnce();
  PrivateChannel.current.receive({ type:'close' }); expect(host.isConnected).toBe(false);
});

it('leaves the old notice unchanged when the worker refuses initialization', async () => {
  const f = setup(); const onReady = vi.fn();
  const pending = openInlineCaptureReview(document, 'document', 'secret', 'capture', {left:588,top:16,width:420,height:200,onReady});
  f.emit({ type:'minted', capability:null });
  await expect(pending).resolves.toBe(false); expect(onReady).not.toHaveBeenCalled();
  expect(document.querySelector('palladin-capture')).toBeNull();
});

it('disables resize animation for reduced motion and revokes on host reparenting', async () => {
  const f = setup(true);
  const pending = openInlineCaptureReview(document, 'document', 'totp', 'capture');
  const host = f.frame() as HTMLElement; expect(host.style.transition).toBe('none');
  document.body.append(host);
  f.emit({type:'attest',requestId:'mutation',phase:'operation',gesture:{x:20,y:20,keyboard:false,at:Date.now()}});
  await expect(pending).resolves.toBe(false);
  expect(f.messages).toContainEqual({type:'attested',requestId:'mutation',ok:false});
  expect(host.isConnected).toBe(false);
});

it('uses an owned modal without popover support and revokes the private session on Escape cancellation', async () => {
  const f = setup(true, true);
  const pending = openInlineCaptureReview(document, 'document', 'login', 'capture');
  const host = f.frame() as HTMLElement;
  const shadow = vi.mocked(Element.prototype.attachShadow).mock.results[0]!.value as ShadowRoot;
  const modal = shadow.querySelector('dialog')!;
  expect(modal.open).toBe(true);
  expect(shadow.querySelector('iframe')!.parentNode).toBe(modal);
  PrivateChannel.current.receive({ type: 'ready' });
  await expect(pending).resolves.toBe(true);
  PrivateChannel.current.receive({ type: 'resize', height: 480 });
  expect(modal.style.height).toBe('480px');
  expect(host.style.height).toBe('480px');
  modal.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(host.isConnected).toBe(false);
  expect(modal.open).toBe(false);
  expect(f.owner.disconnect).toHaveBeenCalledOnce();
  expect(PrivateChannel.current.port1.close).toHaveBeenCalledOnce();
});
