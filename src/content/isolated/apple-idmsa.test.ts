// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://idmsa.apple.com/appleauth/auth/signin"}

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error jsdom is provided by the test environment without TypeScript declarations.
import { JSDOM, ResourceLoader } from 'jsdom';
import { loginTargetFor, performLoginTargetFill, submitFilledLoginTarget } from './fill';
import { startInlineAutofill, startInlineAutofillIfAllowed } from './inline-autofill';

function appleForm(doc: Document = document) {
  doc.body.innerHTML = `
    <div id="sign_in_form" class="hide-password">
      <input id="account_name_text_field" type="text" autocomplete="username webauthn">
      <input id="password_text_field" type="password" autocomplete="off">
      <button id="sign-in" type="button">Continue</button>
    </div>
  `;
  return {
    username: doc.querySelector<HTMLInputElement>('#account_name_text_field')!,
    password: doc.querySelector<HTMLInputElement>('#password_text_field')!,
    form: doc.querySelector<HTMLElement>('#sign_in_form')!,
  };
}

afterEach(() => document.body.replaceChildren());

describe('Apple IDMSA inline login', () => {
  it('starts inside a same-origin iframe and rejects a foreign-origin iframe', async () => {
    Object.assign(globalThis, {
      chrome: { storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } },
    });
    const loader = new class extends ResourceLoader {
      fetch(): Promise<Buffer> {
        // The iframe keeps Apple's sign-in scope, field IDs, visibility class, and staged action.
        // Styling and Apple scripts are omitted because discovery and fill use only these DOM contracts.
        return Promise.resolve(Buffer.from(`<!doctype html><body>
          <div id="sign_in_form" class="hide-password">
            <input id="account_name_text_field" type="text" autocomplete="username webauthn">
            <input id="password_text_field" type="password" autocomplete="off">
            <button id="sign-in" type="button">Continue</button>
          </div></body>`));
      }
    }();
    const top = new JSDOM('<iframe src="https://idmsa.apple.com/appleauth/auth/signin"></iframe>', {
      url: 'https://idmsa.apple.com/IDMSWebAuth/signin', resources: loader,
    });
    const sameOrigin = top.window.document.querySelector('iframe')!;
    await new Promise<void>(resolve => sameOrigin.addEventListener('load', () => resolve(), { once: true }));
    const child = sameOrigin.contentDocument!;
    // Each content script runs with its frame's DOM constructors. Match that
    // realm when invoking the production controller from this parent test.
    for (const name of ['Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
      'HTMLFormElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLSlotElement', 'ShadowRoot'] as const) {
      vi.stubGlobal(name, child.defaultView![name]);
    }
    const subject = startInlineAutofillIfAllowed(child, 'a'.repeat(32), vi.fn(async () => null));
    try {
      expect(subject).not.toBeNull();
      expect(child.querySelectorAll('palladin-autofill')).toHaveLength(1);
      const username = child.querySelector<HTMLInputElement>('#account_name_text_field')!;
      const password = child.querySelector<HTMLInputElement>('#password_text_field')!;
      const target = loginTargetFor(username);
      expect(target).toMatchObject({ username, password: null });
      expect(performLoginTargetFill(target!, [
        { kind: 'username', value: 'member@example.com' },
        { kind: 'password', value: 'secret' },
      ])).toEqual({ ok: true });
      expect(username.value).toBe('member@example.com');
      expect(password.value).toBe('');
      const foreign = top.window.document.createElement('iframe');
      foreign.src = 'https://other.example.com/login';
      top.window.document.body.append(foreign);
      await new Promise<void>(resolve => foreign.addEventListener('load', () => resolve(), { once: true }));
      expect(startInlineAutofillIfAllowed(foreign.contentDocument!, 'b'.repeat(32), vi.fn(async () => null)))
        .toBeNull();
      expect(foreign.contentDocument!.querySelector('palladin-autofill')).toBeNull();
    } finally {
      subject?.stop();
      vi.unstubAllGlobals();
      top.window.close();
    }
  });

  it('mounts the shield in the observed account.apple.com sign-in iframe', async () => {
    Object.assign(globalThis, {
      chrome: { storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } },
    });
    const loader = new class extends ResourceLoader {
      fetch(): Promise<Buffer> { return Promise.resolve(Buffer.from('<!doctype html><body></body>')); }
    }();
    const top = new JSDOM('<iframe src="https://idmsa.apple.com/appleauth/auth/authorize/signin"></iframe>', {
      url: 'https://account.apple.com/sign-in', resources: loader,
    });
    const frame = top.window.document.querySelector('iframe')!;
    await new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
    const child = frame.contentDocument!;
    Object.defineProperty(child, 'referrer', { value: 'https://account.apple.com/' });
    const { username, password } = appleForm(child);
    for (const name of ['Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
      'HTMLFormElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLSlotElement', 'ShadowRoot'] as const) {
      vi.stubGlobal(name, child.defaultView![name]);
    }
    const subject = startInlineAutofillIfAllowed(child, 'a'.repeat(32), vi.fn(async () => null));
    try {
      expect(subject).not.toBeNull();
      expect(child.querySelectorAll('palladin-autofill')).toHaveLength(1);
      const target = loginTargetFor(username);
      expect(target).toMatchObject({ username, password: null });
      expect(performLoginTargetFill(target!, [
        { kind: 'username', value: 'member@example.com' },
        { kind: 'password', value: 'secret' },
      ])).toEqual({ ok: true });
      expect(username.value).toBe('member@example.com');
      expect(password.value).toBe('');
    } finally {
      subject?.stop();
      vi.unstubAllGlobals();
      top.window.close();
    }
  });

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

  it('refuses submit if Apple changes the account after the password fill', async () => {
    const { username, password, form } = appleForm();
    username.value = 'member@example.com';
    form.classList.remove('hide-password');
    const target = loginTargetFor(password)!;
    const action = document.querySelector<HTMLButtonElement>('#sign-in')!;
    const click = vi.spyOn(action, 'click');
    expect(performLoginTargetFill(target, [
      { kind: 'username', value: 'member@example.com' },
      { kind: 'password', value: 'secret' },
    ], 'manual')).toEqual({ ok: true });
    const submission = submitFilledLoginTarget(target, () => true);
    username.value = 'other@example.com';
    expect(await submission).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});
