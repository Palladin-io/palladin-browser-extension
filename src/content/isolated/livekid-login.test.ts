// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.livekid.com/"}
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginTargetFor, performFill, performLoginTargetFill } from './fill';
import { startInlineAutofill } from './inline-autofill';
import type { FillField, InlineAutofillCommand } from '@shared/messaging';

const specimen = readFileSync('tests/fixtures/forms/livekid-login-2026-10-04/page.html', 'utf8');
declare const jsdom: { reconfigure(options: { url: string }): void };
const fields: FillField[] = [
  { kind: 'username', value: 'fixture@example.test' },
  { kind: 'password', value: 'fixture-password' },
];
function mount(localized = false) {
  // Synthetic Polish captions on the observed English DOM; not a captured PL specimen.
  document.body.innerHTML = localized ? specimen.replace('Other login methods', 'Inne metody logowania')
    .replace('Sign in', 'Zaloguj się') : specimen;
  return {
    username: document.querySelector<HTMLInputElement>('input[name="mail"]')!,
    password: document.querySelector<HTMLInputElement>('input[name="password"]')!,
  };
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('observed LiveKid login specimen', () => {
  it('detects the pair without depending on English alternative-login captions', () => {
    const { username, password } = mount(true);
    expect(loginTargetFor(username)).toMatchObject({ username, password });
  });

  it.each(['http://app.livekid.com/', 'https://other.livekid.com/', 'https://example.test/'])(
    'does not recognize the structural exception at %s', (url) => {
      const { username } = mount(true);
      jsdom.reconfigure({ url });
      try { expect(loginTargetFor(username)).toBeNull(); }
      finally { jsdom.reconfigure({ url: 'https://app.livekid.com/' }); }
    },
  );

  it.each(['hidden-password', 'new-password', 'second-username', 'foreign-password', 'missing-action'])(
    'rejects the localized structure after %s', (mutation) => {
      const { username, password } = mount(true);
      if (mutation === 'hidden-password') password.hidden = true;
      if (mutation === 'new-password') password.autocomplete = 'new-password';
      if (mutation === 'second-username') username.after(username.cloneNode());
      if (mutation === 'foreign-password') document.body.append(password);
      if (mutation === 'missing-action') document.querySelector('#login-button')!.remove();
      expect(loginTargetFor(username)).toBeNull();
    },
  );

  it('detects the form-less pair and fills it through the popup', () => {
    const { username, password } = mount();
    expect(username.form).toBeNull();
    expect(loginTargetFor(username)).toMatchObject({ username, password });
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect(username.value).toBe(fields[0]!.value);
    expect(password.value).toBe(fields[1]!.value);
  });

  it.each(['username', 'password'] as const)('preserves an existing %s during automatic fill', (key) => {
    const controls = mount();
    controls[key].value = 'existing-value';
    expect(performLoginTargetFill(loginTargetFor(controls.username)!, fields, 'automatic'))
      .toEqual({ ok: false, reason: 'no-form' });
    expect(controls[key].value).toBe('existing-value');
    expect(controls[key === 'username' ? 'password' : 'username'].value).toBe('');
  });

  it('allows a manually selected account to replace existing values', () => {
    const { username, password } = mount();
    username.value = 'previous@example.test'; password.value = 'previous-password';
    expect(performLoginTargetFill(loginTargetFor(username)!, fields, 'manual')).toEqual({ ok: true });
    expect(username.value).toBe(fields[0]!.value); expect(password.value).toBe(fields[1]!.value);
  });

  it('rejects a replaced password control before writing either value', () => {
    const { username, password } = mount();
    const target = loginTargetFor(username)!;
    password.replaceWith(password.cloneNode());
    expect(performLoginTargetFill(target, fields)).toEqual({ ok: false, reason: 'no-form' });
    expect(username.value).toBe(''); expect(password.value).toBe('');
  });

  it('fills one exact-host suggestion once without focus or submitting', async () => {
    const { username, password } = mount(true);
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
    const clicked = vi.fn(); const changed = vi.fn();
    document.querySelector('#login-button')!.addEventListener('click', clicked);
    document.body.addEventListener('input', changed);
    const send = vi.fn(async (command: InlineAutofillCommand) => {
      if (command.type === 'inline/list') return {
        ok: true, kind: 'suggestions', status: 'ready', entries: [{
          vaultId: 'v1', entryId: 'e1', name: 'LiveKid', username: fields[0]!.value,
          vaultName: 'Personal', urlDomain: 'app.livekid.com', updatedAt: '2026-10-04T08:00:00Z', match: 'exact',
        }],
      };
      if (command.type === 'inline/fill') {
        const target = subject.resolveLoginTarget(command.loginTargetId);
        expect(target).not.toBeNull();
        expect(performLoginTargetFill(target!, fields, 'automatic')).toEqual({ ok: true });
        return { ok: true, kind: 'fill', status: 'filled' };
      }
      throw new Error('Unexpected inline command');
    });
    const subject = startInlineAutofill(document, 'a'.repeat(32), send);
    try {
      expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
      await vi.waitFor(() => {
        expect(username.value).toBe(fields[0]!.value); expect(password.value).toBe(fields[1]!.value);
      });
      document.body.append(document.createElement('span'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(send.mock.calls.filter(([command]) => command.type === 'inline/fill')).toHaveLength(1);
      expect(changed).toHaveBeenCalledTimes(2); expect(clicked).not.toHaveBeenCalled();
    } finally { subject.stop(); document.body.removeEventListener('input', changed); }
  });
});
