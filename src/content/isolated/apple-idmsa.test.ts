// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://idmsa.apple.com/appleauth/auth/signin"}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginTargetFor, performLoginTargetFill } from './fill';
import { startInlineAutofill } from './inline-autofill';

function appleForm() {
  document.body.innerHTML = `
    <div id="sign_in_form" class="hide-password">
      <input id="account_name_text_field" type="text" autocomplete="username webauthn">
      <input id="password_text_field" type="password" autocomplete="off">
      <button id="sign-in" type="button">Continue</button>
    </div>
  `;
  return {
    username: document.querySelector<HTMLInputElement>('#account_name_text_field')!,
    password: document.querySelector<HTMLInputElement>('#password_text_field')!,
    form: document.querySelector<HTMLElement>('#sign_in_form')!,
  };
}

afterEach(() => document.body.replaceChildren());

describe('Apple IDMSA inline login', () => {
  it('shows the launcher on the identifier step and never fills the hidden password', () => {
    const { username, password } = appleForm();
    Object.assign(globalThis, {
      chrome: { storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } },
    });
    const subject = startInlineAutofill(document, 'a'.repeat(32), vi.fn(async () => null));
    try {
      expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
      const target = loginTargetFor(username);
      expect(target).toMatchObject({ username, password: null });
      expect(loginTargetFor(password)).toBeNull();
      expect(performLoginTargetFill(target!, [
        { kind: 'username', value: 'member@example.com' },
        { kind: 'password', value: 'secret' },
      ])).toEqual({ ok: true });
      expect(username.value).toBe('member@example.com');
      expect(password.value).toBe('');
    } finally {
      subject.stop();
    }
  });

  it('binds the password step to the account already selected on the page', () => {
    const { username, password, form } = appleForm();
    username.value = 'member@example.com';
    form.classList.remove('hide-password');
    const target = loginTargetFor(password);
    expect(target).toMatchObject({ username: null, password, accountIdentity: username });
    expect(loginTargetFor(username)).toBeNull();
    expect(performLoginTargetFill(target!, [
      { kind: 'username', value: 'other@example.com' },
      { kind: 'password', value: 'secret' },
    ], 'manual')).toEqual({ ok: false, reason: 'no-form' });
    expect(password.value).toBe('');
    expect(performLoginTargetFill(target!, [
      { kind: 'username', value: 'member@example.com' },
      { kind: 'password', value: 'secret' },
    ], 'manual')).toEqual({ ok: true });
    expect(password.value).toBe('secret');
  });

  it('does not automatically fill the password stage', async () => {
    const { username, form } = appleForm();
    username.value = 'member@example.com';
    form.classList.remove('hide-password');
    Object.assign(globalThis, {
      chrome: { storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } },
    });
    const send = vi.fn(async () => null);
    const subject = startInlineAutofill(document, 'a'.repeat(32), send);
    try {
      expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
      subject.retryAutomaticFill();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
    } finally {
      subject.stop();
    }
  });
});
