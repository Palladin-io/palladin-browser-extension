// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startInlineAutofill } from './inline-autofill';
let controller: ReturnType<typeof startInlineAutofill> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { chrome: { runtime: { sendMessage: vi.fn() }, storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } } });
});
afterEach(() => { controller?.stop(); controller = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
const form = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>';
const start = () => { controller = startInlineAutofill(document, 'a'.repeat(32), async () => ({ ok: true, kind: 'suggestions', status: 'locked', entries: [] })); };
it('bounds full scans during continuous unrelated SPA updates without starving a new form', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  document.body.innerHTML = '<div id="feed"></div>';
  const queries = vi.spyOn(document, 'querySelectorAll');
  start(); queries.mockClear();
  const feed = document.querySelector('#feed')!;
  for (let tick = 0; tick < 200; tick++) {
    feed.textContent = `Update ${tick}`;
    if (tick === 50) document.body.insertAdjacentHTML('beforeend', form);
    await vi.advanceTimersByTimeAsync(1);
    if (tick === 150) expect(document.querySelector('palladin-autofill')).not.toBeNull();
  }
  expect(queries.mock.calls.filter(([selector]) => selector === '*').length).toBeLessThanOrEqual(6);
});
it('restores a removed shield host without duplicating or restarting its widget', async () => {
  document.body.innerHTML = form; start();
  const host = document.querySelector('palladin-autofill')!;
  host.remove();
  await vi.waitFor(() => expect(host.isConnected).toBe(true));
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
  // A restored host must not trigger a self-maintaining scan/remount cycle.
  const queries = vi.spyOn(document, 'querySelectorAll');
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(queries.mock.calls.filter(([selector]) => selector === '*').length).toBeLessThanOrEqual(2);
  expect(document.querySelector('palladin-autofill')).toBe(host);
});
it('cancels a scheduled scan when the controller stops', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  start(); document.body.innerHTML = form;
  await Promise.resolve(); controller!.stop();
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector('palladin-autofill')).toBeNull();
});

// Synthetic component lifecycle: the host is already connected at startup.
// attachShadow and shadow-internal mutations produce no light-DOM records.
it.each(['late-login-fields', 'div'])('discovers an open root attached later to an existing %s host without unrelated mutations', async tag => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const host = document.createElement(tag); document.body.append(host); start();
  await vi.advanceTimersByTimeAsync(200);
  host.attachShadow({ mode: 'open' }).innerHTML = form;
  await vi.advanceTimersByTimeAsync(700);
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
});
it('does not rescan the idle document while probing future open hosts, and releases probes on stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  document.body.innerHTML = '<late-empty-fields></late-empty-fields>';
  start(); await vi.advanceTimersByTimeAsync(200);
  const queries = vi.spyOn(document, 'querySelectorAll');
  await vi.advanceTimersByTimeAsync(2000);
  expect(queries).not.toHaveBeenCalled();
  controller!.stop();
  document.querySelector('late-empty-fields')!.attachShadow({ mode: 'open' }).innerHTML = form;
  await vi.advanceTimersByTimeAsync(1000);
  expect(queries).not.toHaveBeenCalled();
  expect(document.querySelector('palladin-autofill')).toBeNull();
});
it('never enters a later closed shadow root', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const host = document.createElement('private-login-fields'); document.body.append(host); start();
  await vi.advanceTimersByTimeAsync(200);
  host.attachShadow({ mode: 'closed' }).innerHTML = form;
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector('palladin-autofill')).toBeNull();
});
it('caps host probes per tick and rotates past early hosts across unrelated scans', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const hosts = Array.from({ length: 600 }, () => document.createElement('late-rotating-fields'));
  document.body.append(...hosts); start();
  const probes = hosts.map(host => vi.spyOn(host, 'shadowRoot', 'get'));
  await vi.advanceTimersByTimeAsync(250);
  expect(probes.reduce((sum, probe) => sum + probe.mock.calls.length, 0)).toBeLessThanOrEqual(256);
  probes.forEach(probe => probe.mockRestore());
  hosts[599]!.attachShadow({ mode: 'open' }).innerHTML = form;
  // These scans must not keep resetting the probe cursor to the first host.
  for (let tick = 0; tick < 10; tick++) {
    document.body.className = `synthetic-${tick}`;
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
});
