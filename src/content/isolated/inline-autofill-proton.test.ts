// @vitest-environment jsdom
import { observeNativeSubmit } from './manual-submit.test-helper';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InlineAutofillCommand } from '@shared/messaging';
import { performBoundFill } from './fill';
import { startInlineAutofill } from './inline-autofill';

let stop: (() => void) | undefined;
beforeEach(() => {
  Object.assign(globalThis, { chrome: { runtime: { sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } } });
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    return attach.call(this, { ...init, mode: 'open' });
  });
  document.body.innerHTML = readFileSync('tests/fixtures/forms/proton-login-2026-09-20/page.html', 'utf8');
});
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture(automatic = true, replyDelay = false) {
  const username = document.querySelector<HTMLInputElement>('#username')!;
  const password = document.querySelector<HTMLInputElement>('#password')!;
  const form = document.querySelector('form')!;
  const submit = observeNativeSubmit(form);
  let controller: ReturnType<typeof startInlineAutofill>;
  let lists = 0;
  const send = vi.fn(async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready',
      entries: !automatic && ++lists === 1 ? [] : [{ vaultId: 'v1', entryId: 'e1', name: 'Proton', username: 'synthetic@example.test',
        vaultName: 'Fixture', urlDomain: 'account.proton.me', updatedAt: '2026-09-20T00:00:00Z', match: 'exact' }] };
    if (command.type !== 'inline/fill') return { ok: false };
    const outcome = performBoundFill(document, { channel: 'palladin.fill/request', documentId: 'fixture-document',
      expectedOrigin: 'https://account.proton.me', expectedDomain: 'account.proton.me', submit: false,
      loginTargetId: command.loginTargetId, intent: command.intent, fields: [{ kind: 'username', value: 'synthetic@example.test' }, { kind: 'password', value: 'Synthetic-password!42' }] },
    'https://account.proton.me/login', 'fixture-document', controller.resolveLoginTarget(command.loginTargetId));
    if (replyDelay) await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, kind: 'fill', status: outcome.ok ? 'filled' : 'no-form' };
  });
  controller = startInlineAutofill(document, 'a'.repeat(32), send);
  stop = () => controller.stop();
  const clickLogin = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.invalidateSuggestions();
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    (root.querySelector('.launcher') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelector('.submit-login')).not.toBeNull());
    (root.querySelector('.submit-login') as HTMLButtonElement).click();
    return root;
  };
  return { username, password, form, submit, send, clickLogin };
}

it('submits the observed Proton form after automatic fill without rewriting matching values', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.password.value).toBe('Synthetic-password!42'));
  expect(f.submit).not.toHaveBeenCalled();
  const input = vi.fn(); const change = vi.fn();
  f.form.addEventListener('input', input); f.form.addEventListener('change', change);
  await f.clickLogin();
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledExactlyOnceWith(f.form.querySelector('[type="submit"]')));
  expect(input).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  expect(f.send.mock.calls.filter(([command]) => command.type === 'inline/fill')).toHaveLength(2);
});

it.each(['username', 'password'] as const)('explicitly replaces a different %s left by another autofill provider', async field => {
  const f = fixture(); await vi.waitFor(() => expect(f.password.value).toBe('Synthetic-password!42'));
  f[field].value = 'different-synthetic-value';
  expect(f.submit).not.toHaveBeenCalled();
  await f.clickLogin();
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect([f.username.value, f.password.value]).toEqual(['synthetic@example.test', 'Synthetic-password!42']);
  expect(f.send.mock.calls.filter(([command]) => command.type === 'inline/fill').map(([command]) =>
    command.type === 'inline/fill' ? command.intent : null)).toEqual(['automatic', 'manual']);
});

it('lets queued framework input state settle before an explicit manual submit', async () => {
  const f = fixture(false);
  let settled = false;
  f.password.addEventListener('input', () => { setTimeout(() => { settled = true; }, 0); });
  const atSubmit: boolean[] = [];
  f.submit.mockImplementation(() => { atSubmit.push(settled); });
  await f.clickLogin();
  await vi.waitFor(() => expect(atSubmit).toEqual([true]));
});

it.each(['value', 'owner'] as const)('does not submit if a queued framework change replaces the %s binding', async mutation => {
  const f = fixture(false);
  f.password.addEventListener('input', () => { setTimeout(() => {
    if (mutation === 'value') f.password.value = 'different-synthetic-value';
    else { const other = document.createElement('form'); other.id = 'other'; document.body.append(other); f.password.setAttribute('form', 'other'); }
  }, 0); });
  await f.clickLogin();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.submit).not.toHaveBeenCalled();
});

it('rejects a page mutation after the bound fill but before the worker reply', async () => {
  const f = fixture(false, true);
  f.password.addEventListener('input', () => { queueMicrotask(() => { f.password.value = 'changed-before-reply'; }); });
  await f.clickLogin();
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.submit).not.toHaveBeenCalled();
});
