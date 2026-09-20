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
it('does not reinterpret a covered password as an absent field in an identifier-only plan', () => {
  document.body.innerHTML = '<form><h2>Sign in</h2><input autocomplete="username"><input type="password"><div>Continue</div></form>';
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => dom.isVisible(element) && !element.matches('input[type="password"]') });
  expect(live.inspect(url)).toBeNull();
});
it('rejects a newly editable covered password before committing the identifier', async () => {
  document.body.innerHTML = generic;
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => dom.isVisible(element) && !element.matches('input[type="password"]') });
  const submitted = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(live); expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector<HTMLInputElement>('input[type="password"]')!.style.opacity = '1';
  expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(submitted).not.toHaveBeenCalled();
});
it.each(['new-password', 'one-time-code', 'signup', 'no-context'])('revalidates %s credential context before the deferred commit', async mutation => {
  const instance = setup(generic), submitted = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(instance); expect(ready.ok).toBe(true); if (!ready.ok) return;
  if (mutation === 'new-password' || mutation === 'one-time-code') document.querySelector('form')!.insertAdjacentHTML('beforeend', `<input hidden autocomplete="${mutation}">`);
  if (mutation === 'signup') document.querySelector('form')!.insertAdjacentHTML('afterbegin', '<h2>Create an account</h2>');
  if (mutation === 'no-context') document.querySelector('input[type="password"]')!.remove();
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(submitted).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('accepts an initially disabled native submit input that becomes enabled after the identifier write', async () => {
  const instance = setup(generic.replace('<div>Continue</div>', '<input type="submit" value="Continue" disabled>'));
  const submitted = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submitted);
  document.querySelector('input')!.addEventListener('input', () => { document.querySelector<HTMLInputElement>('input[type="submit"]')!.disabled = false; });
  const ready = await filled(instance, 'absent'); expect(ready.ok).toBe(true); if (!ready.ok) return;
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(1);
});
it.each([
  '<h4>Create your account</h4>', '<h5>Załóż konto</h5>', '<h6>Opprett profil</h6>', '<header>Sign up</header>',
])('rejects registration heading vocabulary inside and beside the native form: %s', heading => {
  expect(setup(generic.replace('<form>', `<form>${heading}`)).inspect(url)).toBeNull();
  expect(setup(`<section>${heading}${generic}</section>`).inspect(url)).toBeNull();
});
it('revalidates a surrounding registration heading before committing', async () => {
  const instance = setup(`<section><h4>Sign in</h4>${generic}</section>`), submitted = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(instance); expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector('h4')!.textContent = 'Create your account';
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(submitted).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('does not borrow a registration heading from an unrelated sibling card', () => {
  expect(setup(`<section><h4>Create your account</h4></section><section>${generic}</section>`).inspect(url)?.version).toBe(2);
});
it.each(['hidden', 'style="display:none"', 'style="opacity:0"'])('does not authorize deferred discovery from an inactive login heading: %s', hidden => {
  expect(setup(`<form><div ${hidden}><h2>Sign in</h2></div><input autocomplete="username"><div>Continue</div></form>`).inspect(url)).toBeNull();
});
it('revalidates visible login-heading evidence before commit', async () => {
  const instance = setup('<form><h2>Sign in</h2><input autocomplete="username"><div>Continue</div></form>');
  const submitted = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submitted);
  const ready = await filled(instance); expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector('h2')!.hidden = true;
  expect(instance.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'login.example.test', submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(submitted).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
});
it('ignores inactive registration headings inside the form and its surrounding card', () => {
  expect(setup(`<section><h4 hidden>Create your account</h4>${generic.replace('<form>', '<form><h2 hidden>Sign up</h2>')}</section>`).inspect(url)?.version).toBe(2);
});
