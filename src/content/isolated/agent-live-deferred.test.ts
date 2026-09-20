// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
const documentId = 'd'.repeat(32), url = 'https://login.example.test/';
let live: LiveLogin | undefined;
const dom = { isVisible: (element: HTMLElement) => {
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.style.display === 'none' || parent.style.opacity === '0' || parent.style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
} };
const generic = '<form><input autocomplete="username"><input type="password" style="opacity:0"><div>Continue</div></form>';
function setup(html: string) { document.body.innerHTML = html; return live = new LiveLogin(document, documentId, () => url, () => true, dom); }
afterEach(() => { live?.clear(); document.body.replaceChildren(); vi.useRealTimers(); });
it('discovers the observed initial X identifier as explicit deferred native submit, without inventing DIV clicks', () => {
  const instance = setup(readFileSync('tests/fixtures/forms/x-deferred-login-2026-09-20.html', 'utf8'));
  const plan = instance.inspect(url);
  expect(plan?.version).toBe(2);
  expect(plan?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username']);
  expect(plan?.steps[0]?.submit.action).toBe('deferred-native-click');
});
it('prepares a generic delayed action only for a credential identifier scope', () => {
  expect(setup(generic).inspect(url)?.version).toBe(2);
  for (const html of [
    '<form><input type="email"><div>Continue</div></form>',
    '<form><input autocomplete="username"><input type="password" autocomplete="new-password" style="opacity:0"><div>Continue</div></form>',
    '<form><input autocomplete="one-time-code"><div>Continue</div></form>',
    '<form><input autocomplete="username"><input type="password"><div>Continue</div></form>',
    generic + generic,
  ]) expect(setup(html).inspect(url)).toBeNull();
});

// All post-input behavior below is a synthetic mechanism, not observed X JavaScript.
async function filled(instance: LiveLogin, mode = 'ready') {
  const plan = instance.inspect(url)!;
  const input = document.querySelector<HTMLInputElement>('input')!;
  input.addEventListener('input', () => {
    if (mode !== 'absent') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<button type="submit">Continue</button>');
    if (mode === 'foreign-action') document.querySelector('form')!.action = 'https://other.example.test/';
    if (mode === 'ambiguous') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<button type="submit">Continue</button>');
  });
  return instance.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test',
    expiresAt: Date.now() + 20_000, form: plan, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }] });
}
it('fills once, reports an actual native button and waits for a separate single-use commit', async () => {
  const instance = setup(generic), submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submit);
  const input = document.querySelector('input')!, changed = vi.fn(); input.addEventListener('input', changed);
  const result = await filled(instance); expect(result.ok).toBe(true); if (!result.ok) return;
  expect(changed).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
  const commit = { channel: 'palladin.agent-live/deferred-commit' as const, submitReady: result.submitReady, expectedDomain: 'login.example.test', expiresAt: Date.now() + 1000 };
  expect(instance.commitDeferred(commit)).toEqual({ ok: true });
  expect(instance.commitDeferred(commit).ok).toBe(false); expect(submit).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
});
it.each(['identity', 'replacement', 'action', 'base', 'captcha', 'pending-id', 'expired-commit', 'cancel'])('rejects %s between ready and commit without a click', async mutation => {
  const instance = setup(generic), submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submit);
  const result = await filled(instance); expect(result.ok).toBe(true); if (!result.ok) return;
  const input = document.querySelector<HTMLInputElement>('input')!;
  const base = document.createElement('base');
  try {
    if (mutation === 'identity') input.value = 'foreign@example.test';
    if (mutation === 'replacement') document.querySelector('button')!.replaceWith(document.querySelector('button')!.cloneNode(true));
    if (mutation === 'action') document.querySelector('form')!.action = 'https://other.example.test/';
    if (mutation === 'base') { base.href = 'https://other.example.test/'; document.head.append(base); }
    if (mutation === 'captcha') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<div data-sitekey="synthetic"></div>');
    if (mutation === 'cancel') instance.cancelDeferred(result.submitReady.pendingId);
    expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', submitReady: { ...result.submitReady, ...(mutation === 'pending-id' ? { pendingId: 'c'.repeat(32) } : {}) },
      expectedDomain: 'login.example.test', expiresAt: Date.now() + (mutation === 'expired-commit' ? -1 : 1000) }).ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe(mutation === 'identity' ? 'foreign@example.test' : '');
  } finally { base.remove(); }
});
it.each(['foreign-action', 'ambiguous'])('rejects %s introduced during the single input write', async mode => {
  expect((await filled(setup(generic), mode)).ok).toBe(false);
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('never clicks an unannotated DIV and cancels after bounded discovery', async () => {
  vi.useFakeTimers(); const instance = setup(generic), clicked = vi.fn(); document.querySelector('div')!.addEventListener('click', clicked);
  const response = filled(instance, 'absent'); await vi.advanceTimersByTimeAsync(5_001);
  expect((await response).ok).toBe(false); expect(clicked).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('cannot extend the pending lifetime through clock rollback or a later commit expiry', async () => {
  vi.useFakeTimers(); const instance = setup(generic), response = await filled(instance); expect(response.ok).toBe(true); if (!response.ok) return;
  const start = Date.now(); vi.setSystemTime(start - 60_000); await vi.advanceTimersByTimeAsync(10_001);
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: response.submitReady, expiresAt: start + 60_000 }).ok).toBe(false);
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('preserves an already matching identifier without input/change while waiting for a native action', async () => {
  vi.useFakeTimers(); const instance = setup(generic), input = document.querySelector<HTMLInputElement>('input')!;
  input.value = 'synthetic@example.test'; const events = vi.fn(); input.addEventListener('input', events); input.addEventListener('change', events);
  const plan = instance.inspect(url)!;
  setTimeout(() => document.querySelector('form')!.insertAdjacentHTML('beforeend','<button>Continue</button>'), 50);
  const pending = instance.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test',
    expiresAt: Date.now() + 10_000, form: plan, values: [{ entryFieldId: 'credential.username', value: input.value }] });
  await vi.advanceTimersByTimeAsync(100); const result = await pending;
  expect(result.ok).toBe(true); expect(events).not.toHaveBeenCalled();
  if (result.ok) instance.cancelDeferred(result.submitReady.pendingId);
  expect(input.value).toBe('synthetic@example.test');
});
it('uses ordinary v1 for a matching username whose native action is already enabled', () => {
  const instance = setup(generic.replace('<div>Continue</div>','<button>Continue</button>'));
  document.querySelector<HTMLInputElement>('input')!.value = 'synthetic@example.test';
  expect(instance.inspect(url)?.version).toBe(1);
});
