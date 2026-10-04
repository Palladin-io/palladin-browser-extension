// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://idmsa.apple.com/appleauth/auth/signin"}
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { loginTargetFor } from './credential-form-analysis';
import { LiveLogin } from './agent-live-login';
import { isVisibleScopeHint } from './login-controls';
const html = readFileSync('tests/fixtures/forms/apple-id-2026-10-02/page.html', 'utf8');
const url = 'https://idmsa.apple.com/appleauth/auth/signin';
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); document.body.replaceChildren(); });
it('prepares only the identifier in the observed form-less Apple first stage', () => {
  document.body.innerHTML = html;
  live = new LiveLogin(document, 'd'.repeat(32), () => url, () => true, { isVisible: isVisibleScopeHint });
  expect(live.inspect(url)?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username']);
});
it.each(['no-password', 'new-password', 'competing-action', 'extra-field'])('rejects %s in a form-less identifier scope', mutation => {
  document.body.innerHTML = html;
  if (mutation === 'no-password') document.querySelector('#password_text_field')!.remove();
  if (mutation === 'new-password') document.querySelector('#password_text_field')!.setAttribute('autocomplete', 'new-password');
  if (mutation === 'competing-action') document.querySelector('#sign-in')!.after(document.querySelector('#sign-in')!.cloneNode(true));
  if (mutation === 'extra-field') document.querySelector('#account_name_text_field')!.after(document.createElement('input'));
  live = new LiveLogin(document, 'd'.repeat(32), () => url, () => true, { isVisible: isVisibleScopeHint });
  expect(live.inspect(url)).toBeNull();
});

it('keeps the user adapter identifier-only on the same Apple specimen', () => {
  document.body.innerHTML = html;
  const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
  const target = loginTargetFor(username);
  expect(target?.username).toBe(username);
  expect(target?.password).toBeNull();
});
// Synthetic next stage on the observed structure; not observed Apple behavior.
it('continues to a form-less password stage while comparing the carried identifier', () => {
  document.body.innerHTML = html;
  document.querySelector('#sign_in_form')!.classList.remove('hide-password');
  document.querySelector<HTMLElement>('.password .form-cell-wrapper')!.style.height = '40px';
  const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
  username.value = 'synthetic@example.test'; username.readOnly = true;
  const button = document.querySelector<HTMLButtonElement>('#sign-in')!;
  button.textContent = 'Zaloguj się'; button.disabled = true;
  live = new LiveLogin(document, 'd'.repeat(32), () => url, () => true, { isVisible: isVisibleScopeHint });
  expect(live.inspect(url)?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
});

// The new frame path must not pair a password with a changed account identity.
it('refuses the password when the carried Apple identifier no longer matches the authorized username', async () => {
  document.body.innerHTML = html;
  document.querySelector('#sign_in_form')!.classList.remove('hide-password');
  document.querySelector<HTMLElement>('.password .form-cell-wrapper')!.style.height = '40px';
  const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
  username.value = 'synthetic@example.test'; username.readOnly = true;
  live = new LiveLogin(document, 'd'.repeat(32), () => url, () => true, { isVisible: isVisibleScopeHint });
  const plan = live.inspect(url)!;
  expect(plan).not.toBeNull();
  username.value = 'different@example.test';
  const response = await live.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'a'.repeat(32),
    documentId: 'd'.repeat(32), expectedDomain: 'idmsa.apple.com', form: plan, expiresAt: Date.now() + 1000,
    requireExistingUsername: true, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' },
      { entryFieldId: 'credential.password', value: 'Synthetic-only-password!42' }] });
  expect(response.ok).toBe(false);
  expect(document.querySelector<HTMLInputElement>('#password_text_field')!.value).toBe('');
});
