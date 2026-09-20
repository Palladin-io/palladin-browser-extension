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
