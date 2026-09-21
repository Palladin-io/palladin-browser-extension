// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isLoginField, startInlineAutofill } from './inline-autofill';

let controller: ReturnType<typeof startInlineAutofill> | undefined;
let resized: (() => void) | undefined;
const observe = vi.fn(); const unobserve = vi.fn(); const disconnect = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { chrome: { runtime: { sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } } });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe; unobserve = unobserve; disconnect = disconnect;
  });
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    return attach.call(this, { ...init, mode: 'open' });
  });
});
afterEach(() => {
  controller?.stop(); controller = undefined; resized = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});
const form = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>';
function start() {
  controller = startInlineAutofill(document, 'a'.repeat(32), async () => ({ ok: true, kind: 'suggestions', status: 'locked', entries: [] }));
}
function geometry(input: HTMLInputElement) {
  const rect = { top: 80, left: 20, right: 320, bottom: 120, width: 300, height: 40 };
  vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }));
  return rect;
}
it('repositions after sibling validation text moves the field without resizing it', async () => {
  document.body.innerHTML = '<div id="error"> </div>' + form;
  const rect = geometry(document.querySelector('input')!); start();
  const host = document.querySelector<HTMLElement>('palladin-autofill')!;
  expect(host.style.top).toBe('87px');
  // Drain the mount frame first: the regression must be caused by the later error.
  await new Promise(resolve => setTimeout(resolve, 40));
  rect.top = 140; rect.bottom = 180;
  document.querySelector('#error')!.firstChild!.textContent = 'Account is required';
  await vi.waitFor(() => expect(host.style.top).toBe('147px'));
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
});
it('recovers geometry after zero-size startup and releases observers on stop', async () => {
  document.body.innerHTML = form;
  const input = document.querySelector('input')!;
  const rect = geometry(input); rect.width = 0; rect.height = 0; start();
  const host = document.querySelector<HTMLElement>('palladin-autofill')!;
  expect(host.style.display).toBe('none');
  await new Promise(resolve => setTimeout(resolve, 40));
  rect.width = 300; rect.height = 40; resized?.();
  await vi.waitFor(() => expect(host.style.display).toBe('block'));
  expect(observe).toHaveBeenCalledWith(input);
  input.remove();
  await vi.waitFor(() => expect(unobserve).toHaveBeenCalledWith(input));
  controller?.stop(); expect(disconnect).toHaveBeenCalled();
});
it('tracks identifier/password replacement inside an existing open shadow root', async () => {
  const component = document.createElement('section'); document.body.append(component);
  const root = component.attachShadow({ mode: 'open' });
  root.innerHTML = '<form><input autocomplete="username"><button type="submit">Continue</button></form>';
  geometry(root.querySelector('input')!); start();
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
  root.querySelector('form')!.innerHTML = '<input type="password" autocomplete="current-password"><button type="submit">Sign in</button>';
  geometry(root.querySelector('input')!);
  await vi.waitFor(() => expect(observe).toHaveBeenCalledWith(root.querySelector('input')));
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
  component.hidden = true;
  await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(0));
  component.hidden = false;
  await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1));
});
it('moves focus off the page credential only when the user clicks the shield', async () => {
  document.body.innerHTML = form; const input = document.querySelector('input')!;
  geometry(input); input.focus(); start();
  expect(document.activeElement).toBe(input);
  const host = document.querySelector('palladin-autofill')!;
  const launcher = host.shadowRoot!.querySelector<HTMLButtonElement>('.launcher')!;
  launcher.click();
  expect(document.activeElement).toBe(host);
  expect(host.shadowRoot!.activeElement).toBe(launcher);
});


it('mounts only on the observed visible LinkedIn formless variant', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/linkedin-login-2026-09-20/page.html', 'utf8');
  const hidden = document.getElementById('«r0»') as HTMLInputElement;
  const visible = document.getElementById('«r3»') as HTMLInputElement;
  geometry(visible); start();
  expect(isLoginField(hidden)).toBe(false);
  expect(isLoginField(visible)).toBe(true);
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
});


it.each(['transitionend', 'animationend'])('repositions after a completed %s without a size change', async event => {
  document.body.innerHTML = form;
  const input = document.querySelector('input')!;
  const rect = geometry(input); start();
  const host = document.querySelector<HTMLElement>('palladin-autofill')!;
  await new Promise(resolve => setTimeout(resolve, 40));
  rect.top = 180; rect.bottom = 220;
  input.parentElement!.dispatchEvent(new Event(event, { bubbles: true }));
  await vi.waitFor(() => expect(host.style.top).toBe('187px'));
});


it('handles non-composed layout events inside open roots and releases listeners on stop', async () => {
  const component = document.createElement('section'); document.body.append(component);
  const root = component.attachShadow({ mode: 'open' }); root.innerHTML = form;
  const input = root.querySelector('input')!;
  const rect = geometry(input); start();
  const host = document.querySelector<HTMLElement>('palladin-autofill')!;
  await new Promise(resolve => setTimeout(resolve, 40));
  rect.top = 180; rect.bottom = 220;
  input.dispatchEvent(new Event('transitionend', { bubbles: true, composed: false }));
  await vi.waitFor(() => expect(host.style.top).toBe('187px'));
  controller!.stop();
  const bounds = vi.spyOn(input, 'getBoundingClientRect'); bounds.mockClear();
  input.dispatchEvent(new Event('animationend', { bubbles: true, composed: false }));
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(bounds).not.toHaveBeenCalled();
});
