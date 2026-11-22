// @vitest-environment jsdom
import { observeNativeSubmit } from './manual-submit.test-helper';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineAutofillCommand } from '@shared/messaging';
import { startInlineAutofill } from './inline-autofill';
import { performBoundFill, loginTargetFor, submitLoginForm } from './fill';

let stop: (() => void) | undefined;
beforeEach(() => {
  Object.assign(globalThis, { chrome: { runtime: { sendMessage: vi.fn() },
    storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } } });
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    return attach.call(this, { ...init, mode: 'open' });
  });
});
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

it('mounts a shield on the observed JetBrains identifier and rebinds a synthetic password step', async () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/jetbrains-identifier-2026-09-20/page.html', 'utf8');
  const form = document.querySelector('form')!;
  const identifier = document.querySelector<HTMLInputElement>('#email')!;
  const submit = observeNativeSubmit(form);
  let controller: ReturnType<typeof startInlineAutofill>;
  const targetIds: string[] = [];
  const fill = (loginTargetId: string) => performBoundFill(document, { channel: 'palladin.fill/request', documentId: 'fixture-document',
    expectedOrigin: 'https://account.jetbrains.com', expectedDomain: 'account.jetbrains.com', submit: false, loginTargetId,
    fields: [{ kind: 'username', value: 'synthetic@example.test' }, { kind: 'password', value: 'Synthetic-password!42' }] },
  'https://account.jetbrains.com/login', 'fixture-document', controller.resolveLoginTarget(loginTargetId));
  const send = vi.fn(async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'JetBrains', username: 'synthetic@example.test', vaultName: 'Fixture',
      urlDomain: 'account.jetbrains.com', updatedAt: '2026-09-20T00:00:00Z', match: 'exact' }] };
    if (command.type !== 'inline/fill') return { ok: false };
    targetIds.push(command.loginTargetId);
    return { ok: true, kind: 'fill', status: fill(command.loginTargetId).ok ? 'filled' : 'no-form' };
  });
  controller = startInlineAutofill(document, 'a'.repeat(32), send); stop = () => controller.stop();
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
  await vi.waitFor(() => expect(identifier.value).toBe('synthetic@example.test'));
  expect(submit).not.toHaveBeenCalled();
  const initialTarget = targetIds[0]!;
  const shadow = document.querySelector('palladin-autofill')!.shadowRoot!;
  (shadow.querySelector('.launcher') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow.querySelector('.submit-login')).not.toBeNull());
  (shadow.querySelector('.submit-login') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  // Only the identifier DOM above was captured. This SPA transition is synthetic.
  form.innerHTML = '<label>Password<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button>';
  await vi.waitFor(() => expect((form.querySelector('input') as HTMLInputElement).value).toBe('Synthetic-password!42'));
  expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1);
  expect(targetIds.at(-1)).not.toBe(initialTarget);
  expect(controller.resolveLoginTarget(initialTarget)).toBeNull();
  expect(fill(initialTarget)).toEqual({ ok: false, reason: 'no-form' });
  expect(submit).toHaveBeenCalledTimes(1);
});

it('fills only the shared formless credential scope and submits its single native action', () => {
  document.body.innerHTML = '<section id="login"><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button type="button">Sign in</button></section><section><input type="search"><button type="button">Search</button></section>';
  const username = document.querySelector<HTMLInputElement>('#username')!;
  const password = document.querySelector<HTMLInputElement>('#password')!;
  const target = loginTargetFor(username);
  expect(target).not.toBeNull();
  expect(performBoundFill(document, { channel: 'palladin.fill/request', documentId: 'doc', expectedOrigin: 'https://example.test',
    expectedDomain: 'example.test', submit: false, loginTargetId: 'login-1',
    fields: [{ kind: 'username', value: 'synthetic' }, { kind: 'password', value: 'synthetic-password' }] }, 'https://example.test/login', 'doc', target)).toEqual({ ok: true });
  const click = vi.spyOn(document.querySelector<HTMLButtonElement>('#login button')!, 'click').mockImplementation(() => {});
  // This call remains bound to the original pair and scope, not just the anchor's latest parent.
  expect(submitLoginForm(password, target!)).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
  const other = document.createElement('section'); document.body.append(other); other.append(password);
  expect(submitLoginForm(username, target!)).toBe(false);
  expect(click).toHaveBeenCalledTimes(1);
});

it('rejects ambiguous formless native actions and never clicks an arbitrary DIV', () => {
  document.body.innerHTML = '<section><input id="username" autocomplete="username"><input type="password" autocomplete="current-password"><button type="button">Sign in</button><button type="button">Continue</button></section>';
  const username = document.querySelector<HTMLInputElement>('#username')!;
  const target = loginTargetFor(username);
  expect(target).not.toBeNull();
  const click = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => {});
  expect(submitLoginForm(username, target!)).toBe(false);
  document.querySelectorAll('button').forEach(button => button.remove());
  document.querySelector('section')!.insertAdjacentHTML('beforeend', '<div role="button">Continue</div>');
  expect(submitLoginForm(username, loginTargetFor(username)!)).toBe(false);
  expect(click).not.toHaveBeenCalled();
});

describe('related-host continuation on a separate password or TOTP stage', () => {
  const related = { vaultId: 'v1', entryId: 'e1', name: 'Fixture', username: 'synthetic@example.test', vaultName: 'Fixture',
    urlDomain: 'login.example.test', updatedAt: '2026-11-22T00:00:00Z', match: 'related' as const };
  function start(html: string, continuation: boolean) {
    document.body.innerHTML = html;
    const commands: InlineAutofillCommand[] = [];
    const send = vi.fn(async (command: InlineAutofillCommand) => {
      commands.push(command);
      if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [related],
        ...(continuation ? { continuation: { vaultId: 'v1', entryId: 'e1' } } : {}) };
      return { ok: true, kind: 'fill', status: 'filled' };
    });
    const controller = startInlineAutofill(document, 'a'.repeat(32), send); stop = () => controller.stop();
    return commands;
  }
  const passwordStage = '<form><label>Password<input type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>';
  const totpStage = '<form><label>MFA code<input id="otp" inputmode="numeric" autocomplete="one-time-code"></label><button type="submit">Submit</button></form>';
  const automaticFills = (commands: InlineAutofillCommand[]) => commands.filter(command => command.type === 'inline/fill' && command.intent === 'automatic');

  it('continues an explicit related choice from the observed AWS identifier into a separate password stage', async () => {
    // Identifier structure observed on AWS (see fixture README); the password stage is synthetic.
    document.body.innerHTML = readFileSync('tests/fixtures/forms/aws-root-identifier-2026-11-22/page.html', 'utf8');
    const form = document.querySelector('form')!;
    const identifier = document.querySelector<HTMLInputElement>('#resolving_input')!;
    const submit = observeNativeSubmit(form);
    let controller: ReturnType<typeof startInlineAutofill>;
    // Models the worker contract under test in inline-runtime.test.ts: a continuation
    // exists only after a successful explicit choice, and automatic related fills require it.
    let continuation: { vaultId: string; entryId: string } | undefined;
    const commands: InlineAutofillCommand[] = [];
    const deliver = (loginTargetId: string) => performBoundFill(document, { channel: 'palladin.fill/request', documentId: 'fixture-document',
      expectedOrigin: 'https://us-east-1.signin.aws.amazon.com', expectedDomain: 'us-east-1.signin.aws.amazon.com', submit: false, loginTargetId,
      fields: [{ kind: 'username', value: related.username }, { kind: 'password', value: 'Synthetic-password!42' }] },
    'https://us-east-1.signin.aws.amazon.com/signin', 'fixture-document', controller.resolveLoginTarget(loginTargetId));
    const send = vi.fn(async (command: InlineAutofillCommand) => {
      commands.push(command);
      if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [related], ...(continuation ? { continuation } : {}) };
      if (command.type !== 'inline/fill') return { ok: false };
      if (command.intent === 'automatic' && command.scope === 'related'
        && (continuation?.entryId !== command.entryId || continuation.vaultId !== command.vaultId)) return { ok: true, kind: 'fill', status: 'blocked' };
      const filled = deliver(command.loginTargetId).ok;
      if (filled && command.intent === 'manual') continuation = { vaultId: command.vaultId, entryId: command.entryId };
      return { ok: true, kind: 'fill', status: filled ? 'filled' : 'no-form' };
    });
    controller = startInlineAutofill(document, 'a'.repeat(32), send); stop = () => controller.stop();
    await vi.waitFor(() => expect(commands.some(command => command.type === 'inline/list')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(identifier.value).toBe('');
    expect(automaticFills(commands)).toEqual([]);

    const shadow = document.querySelector('palladin-autofill')!.shadowRoot!;
    (shadow.querySelector('.launcher') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(shadow.querySelector('.option')).not.toBeNull());
    (shadow.querySelector('.option') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(identifier.value).toBe(related.username));

    form.innerHTML = '<label>Password<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button>';
    const password = form.querySelector<HTMLInputElement>('#password')!;
    await vi.waitFor(() => expect(password.value).toBe('Synthetic-password!42'));
    expect(automaticFills(commands)).toEqual([expect.objectContaining({ entryId: 'e1', scope: 'related' })]);
    expect(submit).not.toHaveBeenCalled();

    form.innerHTML = '<label>Password<input id="password" type="password" autocomplete="current-password" value="typed-by-user"></label><button type="submit">Sign in</button>';
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(form.querySelector<HTMLInputElement>('#password')!.value).toBe('typed-by-user');
    expect(automaticFills(commands)).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('requests the tab-continued related account for a TOTP stage', async () => {
    const commands = start(totpStage, true);
    await vi.waitFor(() => expect(automaticFills(commands)).toHaveLength(1));
    expect(automaticFills(commands)[0]).toMatchObject({ entryId: 'e1', scope: 'related', purpose: 'totp' });
  });

  it('never fills a related account automatically without a tab continuation', async () => {
    const commands = start(passwordStage + totpStage, false);
    await vi.waitFor(() => expect(commands.filter(command => command.type === 'inline/list').length).toBeGreaterThanOrEqual(2));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(automaticFills(commands)).toEqual([]);
  });
});
