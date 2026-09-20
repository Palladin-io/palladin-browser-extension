// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
const url = 'https://login.example.test/#/password', documentId = 'd'.repeat(32);
let live: LiveLogin | undefined;
const dom = { isVisible: (element: HTMLElement) => {
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.style.display === 'none' || parent.style.opacity === '0' || parent.style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
} };
const observed = readFileSync('tests/fixtures/forms/x-deferred-password-2026-09-20.html', 'utf8');
const generic = '<form><input autocomplete="username" disabled><input type="password" autocomplete="current-password"><div>Continue</div></form>';
function setup(html = generic) { document.body.innerHTML = html; return live = new LiveLogin(document, documentId, () => url, () => true, dom); }
afterEach(() => { live?.clear(); document.body.replaceChildren(); vi.useRealTimers(); });
it('discovers the observed production password step and binds the disabled identity without guessing a DIV action', () => {
  const plan = setup(observed).inspect(url);
  expect(plan?.version).toBe(2);
  expect(plan?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
  expect(plan?.steps[0]?.submit.action).toBe('deferred-native-click');
});
it('discovers a generic current-password-only stage without a carried identity', () => {
  const plan = setup('<form><input type="password" autocomplete="current-password"><div>Continue</div></form>').inspect(url);
  expect(plan?.version).toBe(2); expect(plan?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.password']);
});

// Post-password-input behavior is synthetic; production handlers were not captured.
async function filled(instance: LiveLogin, options: { identity?: string; showAction?: boolean; onInput?: () => void } = {}) {
  const identity = document.querySelector<HTMLInputElement>('input[autocomplete="username"]');
  if (identity) identity.value = options.identity ?? 'synthetic@example.test';
  const plan = instance.inspect(url)!;
  document.querySelector('input[type="password"]')!.addEventListener('input', () => {
    options.onInput?.();
    if (options.showAction !== false) document.querySelector('form')!.insertAdjacentHTML('beforeend', '<button type="submit">Continue</button>');
  });
  return instance.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId, expectedDomain: 'login.example.test',
    expiresAt: Date.now() + 10_000, form: plan, values: [
      ...(identity ? [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }] : []),
      { entryFieldId: 'credential.password', value: 'Synthetic-password!42' },
    ] });
}
it.each(['observed', 'disabled', 'readonly', 'password-only'])('writes only password, then requires a separate single-use commit: %s', async variant => {
  const instance = setup(variant === 'observed' ? observed : variant === 'readonly' ? generic.replace('disabled', 'readonly') : variant === 'password-only' ? generic.replace('<input autocomplete="username" disabled>', '') : generic);
  const events = vi.fn(), submitted = vi.fn((event: Event) => event.preventDefault());
  const identity = document.querySelector('input[autocomplete="username"]'); identity?.addEventListener('input', events); identity?.addEventListener('change', events);
  document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(instance); expect(ready.ok).toBe(true); if (!ready.ok) return;
  expect(submitted).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  const commit = { channel: 'palladin.agent-live/deferred-commit' as const, expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 };
  expect(instance.commitDeferred(commit).ok).toBe(true); expect(instance.commitDeferred(commit).ok).toBe(false);
  expect(submitted).toHaveBeenCalledTimes(1); expect(events).not.toHaveBeenCalled();
});
it.each(['', 'foreign@example.test'])('blocks empty or foreign carried identity before password write', async identity => {
  const instance = setup(), events = vi.fn(); document.querySelector('input[type="password"]')!.addEventListener('input', events);
  expect((await filled(instance, { identity })).ok).toBe(false);
  expect(events).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
});
it.each(['identity', 'replacement', 'editable', 'new-password', 'otp', 'signup', 'extra-password', 'foreign-action', 'expired', 'cancel'])('rejects password commit after %s and clears only the newly written password', async mutation => {
  const instance = setup(), submitted = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(instance); expect(ready.ok).toBe(true); if (!ready.ok) return;
  const identity = document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
  if (mutation === 'identity') identity.value = 'changed@example.test';
  if (mutation === 'replacement') { const replacement = identity.cloneNode(true) as HTMLInputElement; replacement.value = identity.value; identity.replaceWith(replacement); }
  if (mutation === 'editable') identity.disabled = false;
  if (mutation === 'new-password') document.querySelector('input[type="password"]')!.setAttribute('autocomplete', 'new-password');
  if (mutation === 'otp') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input hidden autocomplete="one-time-code">');
  if (mutation === 'signup') document.querySelector('form')!.insertAdjacentHTML('afterbegin', '<h2>Create your account</h2>');
  if (mutation === 'extra-password') document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input type="password" hidden>');
  if (mutation === 'foreign-action') document.querySelector('form')!.action = 'https://other.example.test/';
  if (mutation === 'cancel') instance.cancelDeferred(ready.submitReady.pendingId);
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + (mutation === 'expired' ? -1 : 1000) }).ok).toBe(false);
  expect(submitted).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  expect(identity.value).toBe(mutation === 'identity' ? 'changed@example.test' : 'synthetic@example.test');
});
it('rejects a carried identity changed synchronously by the password input handler', async () => {
  const instance = setup();
  expect((await filled(instance, { onInput: () => { document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!.value = 'changed@example.test'; } })).ok).toBe(false);
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
});
it('times out an absent native action without clicking DIV and wipes the password', async () => {
  vi.useFakeTimers(); const instance = setup(), click = vi.fn(); document.querySelector('div')!.addEventListener('click', click);
  const pending = filled(instance, { showAction: false }); await vi.advanceTimersByTimeAsync(5_001);
  expect((await pending).ok).toBe(false); expect(click).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
});
it.each([
  generic.replace('current-password', 'new-password'), generic.replace('current-password', ''),
  generic.replace('disabled', ''), generic.replace('disabled', 'hidden disabled'),
  generic.replace('<form>', '<form><h4>Create your account</h4>'), generic + generic,
  generic.replace('<div>Continue', '<input autocomplete="one-time-code"><div>Continue'),
])('does not defer unsupported password contexts', html => { expect(setup(html).inspect(url)).toBeNull(); });
