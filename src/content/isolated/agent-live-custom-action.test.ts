// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://forms.example.test/login"}
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { isCaptureVisible } from './credential-submission';

const url = 'https://forms.example.test/login', documentId = 'd'.repeat(32);
const fields = '<input autocomplete="username"><input type="password" autocomplete="current-password">';
const anchor = '<a class="button">Sign in</a>';
let live: LiveLogin;
afterEach(() => { live?.clear(); document.body.replaceChildren(); vi.useRealTimers(); });
function setup(html = `<section>${fields}${anchor}</section>`) {
  document.body.innerHTML = html;
  return live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: isCaptureVisible });
}
async function prepare() {
  const form = live.inspect(url); expect(form?.steps[0]?.submit.action).toBe('deferred-control-click');
  if (!form) throw new Error('Missing custom plan');
  return live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture@example.test' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
}
it.each(['formless-anchor', 'sibling-div'])('fills and separately commits the exact bounded %s once', async kind => {
  setup(kind === 'formless-anchor' ? undefined : `<section><form>${fields}</form><div class="btn_primary disabled">登录</div></section>`);
  const action = document.querySelector<HTMLElement>(kind === 'formless-anchor' ? 'a' : '.btn_primary')!;
  const clicked = vi.fn((event: Event) => event.preventDefault()); action.addEventListener('click', clicked);
  document.body.addEventListener('input', () => {
    if ([...document.querySelectorAll('input')].every(input => input.value)) action.classList.remove('disabled');
  }, { signal: AbortSignal.timeout(1000) });
  const prepared = await prepare(); expect(prepared.ok).toBe(true); if (!prepared.ok) return;
  expect(clicked).not.toHaveBeenCalled();
  const commit = { channel: 'palladin.agent-live/deferred-commit' as const, expectedDomain: 'forms.example.test',
    submitReady: prepared.submitReady, expiresAt: Date.now() + 1000 };
  expect(live.commitDeferred(commit).ok).toBe(true);
  expect(live.commitDeferred(commit).ok).toBe(false);
  expect(clicked).toHaveBeenCalledTimes(1);
});
it.each(['href', 'class', 'label', 'hidden', 'disabled', 'replacement', 'duplicate', 'extra-field', 'foreign-action', 'new-password'])(
  'rejects custom action mutation %s before commit and clears its writes', async mutation => {
    setup(`<form>${fields}${anchor}</form>`);
    const action = document.querySelector('a')!, clicked = vi.fn(); action.addEventListener('click', clicked);
    const ready = await prepare(); expect(ready.ok).toBe(true); if (!ready.ok) return;
    if (mutation === 'href') action.href = 'https://other.example.test/';
    if (mutation === 'class') action.className = 'other';
    if (mutation === 'label') action.textContent = 'Create account';
    if (mutation === 'hidden') action.hidden = true;
    if (mutation === 'disabled') action.setAttribute('aria-disabled', 'true');
    if (mutation === 'replacement') action.replaceWith(action.cloneNode(true));
    if (mutation === 'duplicate') action.after(action.cloneNode(true));
    if (mutation === 'extra-field') action.insertAdjacentHTML('beforebegin', '<input name="account">');
    if (mutation === 'foreign-action') document.querySelector('form')!.action = 'https://other.example.test/';
    if (mutation === 'new-password') document.querySelector<HTMLInputElement>('input[type=password]')!.autocomplete = 'new-password';
    expect(live.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
      submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('input')].every(input => input.value === '')).toBe(true);
  });
it.each([
  `<section>${fields}<a class="button" href="/next">Sign in</a></section>`,
  `<section>${fields}<div role="button">Sign in</div></section>`,
  `<section>${fields}<div class="btn_primary">登录/注册</div></section>`,
  `<section>${fields.replace('current-password', 'new-password')}${anchor}</section>`,
  `<section>${fields}<input autocomplete="one-time-code">${anchor}</section>`,
  `<section><form>${fields}</form><form>${fields}</form><div class="btn_primary disabled">登录</div></section>`,
])('does not prepare navigation, arbitrary DIVs, registration, OTP or ambiguous owners', html => {
  expect(setup(html).inspect(url)).toBeNull();
});
it('does not reinterpret an existing native-only preparation as custom-control authorization', async () => {
  setup(`<form>${fields}<button disabled>Sign in</button></form>`);
  const form = live.inspect(url)!; expect(form.steps[0]!.submit.action).toBe('deferred-native-click');
  document.querySelector('button')!.outerHTML = anchor;
  const outcome = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 100, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
  expect(outcome.ok).toBe(false);
});
