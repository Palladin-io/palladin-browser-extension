// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/login"}
import { afterEach, expect, it, vi } from 'vitest';
import { startInlineAutofill } from './inline-autofill';
import type { InlineAutofillCommand } from '@shared/messaging';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('fills an OTP stage that replaces a login form at the same URL, once', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"></form>';
  let subject: ReturnType<typeof startInlineAutofill>;
  let otpRequests = 0;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact',
    }] };
    if (command.type === 'inline/fill' && command.purpose === 'totp') {
      otpRequests++;
      const outcome = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32),
        expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent,
        loginTargetId: command.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] });
      return { ok: true, kind: 'fill', status: outcome.ok ? 'filled' : 'no-form' };
    }
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(document.querySelector('palladin-autofill')).not.toBeNull());
    document.body.innerHTML = '<form><label>Authenticator code<input autocomplete="one-time-code"></label></form>';
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('123456'));
    subject.retryAutomaticFill();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(otpRequests).toBe(1);
  } finally { subject.stop(); }
});

it('does not choose a different account if the tab continuation no longer exists', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  const send = vi.fn(async () => ({ ok: true, kind: 'suggestions', status: 'ready',
    continuation: { vaultId: 'v1', entryId: 'removed' }, entries: [{ vaultId: 'v1', entryId: 'other', name: 'Other', username: 'ada',
      vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] }));
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try { await new Promise(resolve => setTimeout(resolve, 200)); expect(send.mock.calls).toHaveLength(1); }
  finally { subject.stop(); }
});

it('waits for the combined login fill before selecting the TOTP account', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><input autocomplete="one-time-code"></form>';
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const send = async (command: InlineAutofillCommand) => {
    requests.push(`${command.type}:${'purpose' in command ? command.purpose ?? 'login' : 'login'}`);
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact',
    }] };
    if (command.type === 'inline/fill' && command.purpose !== 'totp') await wait;
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(requests).toContain('inline/fill:login');
    expect(requests).not.toContain('inline/list:totp');
  } finally { release(); subject.stop(); }
});

it('offers the closed chooser to retry an OTP after automatic discovery found no entries', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    return native.call(this, { ...init, mode: 'open' });
  });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  let ready = false;
  let subject: ReturnType<typeof startInlineAutofill>;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: ready ? [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact',
    }] : [] };
    if (command.type === 'inline/fill') {
      const outcome = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32),
        expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent,
        loginTargetId: command.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] });
      return { ok: true, kind: 'fill', status: outcome.ok ? 'filled' : 'no-form' };
    }
    return { ok: false, code: 'unavailable' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(document.querySelector('palladin-autofill')).not.toBeNull());
    await new Promise(resolve => setTimeout(resolve, 50)); ready = true;
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.querySelector('.option')).not.toBeNull());
    expect(root.querySelector('.title')?.textContent ?? '').toContain('Palladin');
    expect(root.querySelector('.option')?.textContent).toContain('ada');
    root.querySelector<HTMLButtonElement>('.option')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('123456'));
  } finally { subject.stop(); shadow.mockRestore(); }
});

it('clears the closed chooser and cancels a pending code on lock', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  let command: Extract<InlineAutofillCommand, { type: 'inline/fill' }> | undefined;
  const send = async (request: InlineAutofillCommand) => {
    if (request.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] };
    if (request.type === 'inline/fill') command = request;
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(command).toBeDefined());
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.textContent).toContain('Example'));
    subject.handleSessionChanged('locked');
    expect(root.textContent).not.toContain('Example');
    expect(subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32),
      expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: 'automatic',
      loginTargetId: command!.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] }).ok).toBe(false);
  } finally { subject.stop(); shadow.mockRestore(); }
});

it('does not automatically refill a replaced OTP target repeatedly at the same URL', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  let count = 0;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] };
    if (command.type === 'inline/fill') count++;
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(count).toBe(1));
    document.querySelector('input')!.outerHTML = '<input autocomplete="one-time-code">';
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(count).toBe(1);
  } finally { subject.stop(); }
});

it('invalidates an older OTP suggestion while a manual login account choice is in flight', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><input autocomplete="one-time-code"></form>';
  const entries = [{ vaultId: 'v1', entryId: 'first', name: 'First', username: 'ada', vaultName: 'Personal',
    urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' as const },
    { vaultId: 'v1', entryId: 'second', name: 'Second', username: 'grace', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' as const }];
  let releaseOtp!: () => void, releaseManual!: () => void;
  const otpWait = new Promise<void>(resolve => { releaseOtp = resolve; });
  const manualWait = new Promise<void>(resolve => { releaseManual = resolve; });
  const requests: InlineAutofillCommand[] = [];
  const send = async (command: InlineAutofillCommand) => {
    requests.push(command);
    if (command.type === 'inline/list') {
      if (command.purpose === 'totp') await otpWait;
      return { ok: true, kind: 'suggestions', status: 'ready', entries };
    }
    if (command.type === 'inline/fill' && command.intent === 'manual') await manualWait;
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(requests.some(item => item.type === 'inline/list' && item.purpose === 'totp')).toBe(true));
    const roots = [...document.querySelectorAll('palladin-autofill')].map(host => host.shadowRoot!);
    const loginRoot = roots.find(root => root.querySelector('.launcher') && root.host.getBoundingClientRect().top === 4) ?? roots[0]!;
    loginRoot.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(loginRoot.querySelectorAll('.option').length).toBe(2));
    loginRoot.querySelectorAll<HTMLButtonElement>('.option')[1]!.click();
    await vi.waitFor(() => expect(requests.some(item => item.type === 'inline/fill' && item.intent === 'manual')).toBe(true));
    releaseOtp(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests.filter(item => item.type === 'inline/fill' && item.purpose === 'totp')).toHaveLength(0);
  } finally { releaseOtp(); releaseManual(); subject.stop(); shadow.mockRestore(); }
});

it('shows a chooser for each known OTP target when discovery is ambiguous', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"><input autocomplete="one-time-code"></form>';
  let subject: ReturnType<typeof startInlineAutofill>;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{
      vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal',
      urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] };
    if (command.type === 'inline/fill') {
      const result = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32),
        expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent,
        loginTargetId: command.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] });
      return { ok: true, kind: 'fill', status: result.ok ? 'filled' : 'no-form' };
    }
    return { ok: false, code: 'unavailable' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(2));
    const root = document.querySelectorAll('palladin-autofill')[1]!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.querySelector('.option')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('.option')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll<HTMLInputElement>('input')[1]!.value).toBe('123456'));
    expect(document.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe('');
  } finally { subject.stop(); shadow.mockRestore(); }
});
