// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://idmsa.apple.com/appleauth/auth/authorize/signin"}

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginTargetFor, performLoginTargetFill, submitFilledLoginTarget } from './fill';
import { startInlineAutofill } from './inline-autofill';
import type { InlineAutofillCommand } from '@shared/messaging';

const html = readFileSync('tests/fixtures/forms/apple-account-2026-11-23/identifier.html', 'utf8');
const fields = [
  { kind: 'username', value: 'member@example.com' },
  { kind: 'password', value: 'secret' },
] as const;

function specimen(enableAfterMs: number | null) {
  document.body.innerHTML = html;
  const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
  const password = document.querySelector<HTMLInputElement>('#password_text_field')!;
  const action = document.querySelector<HTMLButtonElement>('#sign-in')!;
  const passkey = document.querySelector<HTMLButtonElement>('#swp')!;
  // Models only the observed timing: Apple enables Continue 16-66 ms after the identifier input.
  username.addEventListener('input', () => {
    if (enableAfterMs !== null) setTimeout(() => { action.disabled = username.value === ''; }, enableAfterMs);
  });
  return { username, password, action, passkey };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Apple Account identifier step - Log in from the inline menu', () => {
  it('continues once Apple enables Continue after the identifier write', async () => {
    const { username, password, action, passkey } = specimen(50);
    const target = loginTargetFor(username)!;
    expect(target).toMatchObject({ username, password: null });
    const click = vi.spyOn(action, 'click');
    const passkeyClick = vi.spyOn(passkey, 'click');

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => true);
    await vi.advanceTimersByTimeAsync(100);

    expect(await submitted).toBe('submitted');
    expect(click).toHaveBeenCalledTimes(1);
    expect(passkeyClick).not.toHaveBeenCalled();
    expect(username.value).toBe('member@example.com');
    expect(password.value).toBe('');
  });

  it('does not click when Continue never becomes enabled', async () => {
    const { username, action, passkey } = specimen(null);
    const target = loginTargetFor(username)!;
    const click = vi.spyOn(action, 'click');
    const passkeyClick = vi.spyOn(passkey, 'click');

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => true);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(await submitted).toBe('no-action');
    expect(click).not.toHaveBeenCalled();
    expect(passkeyClick).not.toHaveBeenCalled();
  });

  it('does not click if the identifier changes while waiting for Continue', async () => {
    const { username, action } = specimen(50);
    const target = loginTargetFor(username)!;
    const click = vi.spyOn(action, 'click');

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => true);
    username.value = 'other@example.com';
    await vi.advanceTimersByTimeAsync(100);

    expect(await submitted).toBe('stale');
    expect(click).not.toHaveBeenCalled();
  });

  it('does not click once the inline operation is superseded while waiting', async () => {
    const { username, action } = specimen(50);
    const target = loginTargetFor(username)!;
    const click = vi.spyOn(action, 'click');
    let current = true;

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => current);
    await vi.advanceTimersByTimeAsync(10);
    current = false;
    await vi.advanceTimersByTimeAsync(100);

    expect(await submitted).toBe('stale');
    expect(click).not.toHaveBeenCalled();
  });
});

describe('Apple Account password step - Log in from the inline menu', () => {
  it('clicks Sign In for the account already selected on the page', async () => {
    document.body.innerHTML = readFileSync('tests/fixtures/forms/apple-account-2026-11-23/password.html', 'utf8');
    const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
    const password = document.querySelector<HTMLInputElement>('#password_text_field')!;
    const action = document.querySelector<HTMLButtonElement>('#sign-in')!;
    username.value = 'member@example.com';
    const target = loginTargetFor(password)!;
    expect(target).toMatchObject({ username: null, password, accountIdentity: username });
    const click = vi.spyOn(action, 'click');

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => true);
    await vi.advanceTimersByTimeAsync(100);

    expect(await submitted).toBe('submitted');
    expect(click).toHaveBeenCalledTimes(1);
    expect(password.value).toBe('secret');
  });
});

describe('Apple Account password step - Polish variant with a passkey action', () => {
  it('clicks only "Zaloguj się", never the passkey action', async () => {
    // Derived from the user's 2026-11-23 screenshot: same structure as password.html,
    // Polish captions and a second passkey action next to the native sign-in action.
    document.body.innerHTML = readFileSync('tests/fixtures/forms/apple-account-2026-11-23/password.html', 'utf8');
    const action = document.querySelector<HTMLButtonElement>('#sign-in')!;
    action.querySelector('span')!.textContent = 'Zaloguj się';
    const passkey = action.cloneNode(true) as HTMLButtonElement;
    passkey.id = 'swp';
    passkey.querySelector('span')!.textContent = 'Zaloguj się, używając klucza';
    action.parentElement!.parentElement!.after(passkey);
    const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
    const password = document.querySelector<HTMLInputElement>('#password_text_field')!;
    username.value = 'member@example.com';
    const target = loginTargetFor(password)!;
    const click = vi.spyOn(action, 'click');
    const passkeyClick = vi.spyOn(passkey, 'click');

    expect(performLoginTargetFill(target, fields, 'manual')).toEqual({ ok: true });
    const submitted = submitFilledLoginTarget(target, () => true);
    await vi.advanceTimersByTimeAsync(100);

    expect(await submitted).toBe('submitted');
    expect(click).toHaveBeenCalledTimes(1);
    expect(passkeyClick).not.toHaveBeenCalled();
  });
});

describe('Apple Account password step - inline menu status after "Log in"', () => {
  it.each([
    ['missing-action', "Login filled, but Palladin couldn't find the sign-in button. Click it yourself to continue."],
    ['changed-account', 'The login form could not be filled.'],
  ])('reports %s without misreporting the completed fill', async (variant, expected) => {
    vi.useRealTimers();
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
      this: Element, init: ShadowRootInit,
    ) { return nativeAttachShadow.call(this, { ...init, mode: 'open' }); });
    Object.assign(globalThis, {
      chrome: { storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } },
    });
    document.body.innerHTML = readFileSync('tests/fixtures/forms/apple-account-2026-11-23/password.html', 'utf8');
    const username = document.querySelector<HTMLInputElement>('#account_name_text_field')!;
    const password = document.querySelector<HTMLInputElement>('#password_text_field')!;
    username.value = 'member@example.com';
    if (variant === 'missing-action') document.querySelector('#sign-in')!.remove();
    const send = vi.fn(async (command: InlineAutofillCommand) => {
      if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
        vaultId: 'v1', entryId: 'e1', name: 'Apple', username: 'member@example.com', vaultName: 'Personal',
        urlDomain: 'idmsa.apple.com', updatedAt: '2026-11-23T00:00:00Z', match: 'exact',
      }] };
      if (command.type !== 'inline/fill') throw new Error('Unexpected command');
      const result = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32),
        expectedOrigin: 'https://idmsa.apple.com', expectedDomain: 'idmsa.apple.com',
        loginTargetId: command.loginTargetId, fields, intent: 'manual', submit: false });
      if (variant === 'changed-account') username.value = 'other@example.com';
      return { ok: true, kind: 'fill', status: result.ok ? 'filled' : 'no-form' };
    });
    const subject = startInlineAutofill(document, 'a'.repeat(32), send);
    try {
      const root = document.querySelector('palladin-autofill')!.shadowRoot!;
      root.querySelector<HTMLButtonElement>('.launcher')!.click();
      await vi.waitFor(() => expect(root.querySelector('.submit-login')).not.toBeNull());
      root.querySelector<HTMLButtonElement>('.submit-login')!.click();
      await vi.waitFor(() => expect(root.querySelector('.status')?.textContent).toBe(expected), { timeout: 3_000 });
      expect(password.value).toBe('secret');
      const reports = send.mock.calls.map(([command]) => command).filter(command => command.type === 'inline/submit-unavailable');
      // The content script never names the site; the worker derives the host from the authenticated sender.
      expect(reports).toEqual(variant === 'missing-action'
        ? [{ channel: 'palladin.inline-autofill.v1', type: 'inline/submit-unavailable', documentId: 'a'.repeat(32) }]
        : []);
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });
});
