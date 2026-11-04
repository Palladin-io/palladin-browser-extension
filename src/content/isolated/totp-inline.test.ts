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

it.each(['scope', 'owner', 'url', 'value'])('rejects %s changes while OTP delivery is pending', async change => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = `<form id="a"><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form><form id="b"></form>`;
  let deliver!: (command: Extract<InlineAutofillCommand, { type: 'inline/fill' }>) => void;
  let subject: ReturnType<typeof startInlineAutofill>;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{ vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] };
    if (command.type === 'inline/fill') await new Promise<void>(resolve => { deliver = cmd => {
      const result = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: cmd.intent, loginTargetId: cmd.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] });
      expect(result.ok).toBe(false); resolve();
    }; deliverCommand = command; });
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  let deliverCommand: Extract<InlineAutofillCommand, { type: 'inline/fill' }>;
  const initialUrl = location.href;
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(deliver).toBeDefined());
    if (change === 'scope') document.querySelector('#b')!.append(document.querySelector('fieldset')!);
    else if (change === 'owner') document.querySelector('input')!.setAttribute('form', 'b');
    else if (change === 'url') history.pushState({}, '', '/other');
    else document.querySelector('input')!.value = '7';
    deliver(deliverCommand!);
    expect(document.querySelectorAll<HTMLInputElement>('input')[1]!.value).toBe('');
  } finally { history.replaceState({}, '', initialUrl); subject.stop(); }
});

it('does not switch account on a password stage when the remembered account is missing', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input type="password"><button>Sign in</button></form>';
  const send = vi.fn(async () => ({ ok: true, kind: 'suggestions', status: 'ready', continuation: { vaultId: 'v1', entryId: 'missing' }, entries: [{ vaultId: 'v1', entryId: 'other', name: 'Other', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] }));
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try { await new Promise(resolve => setTimeout(resolve, 200)); expect(send.mock.calls).toHaveLength(1); }
  finally { subject.stop(); }
});

it.each(['manual-first', 'automatic-first'])('manual OTP selection wins over an older automatic lookup (%s)', async order => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  const entries = ['first', 'second'].map(id => ({ vaultId: 'v1', entryId: id, name: id, username: id, vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' as const }));
  let releaseList!: () => void;
  const blocked = new Promise<void>(resolve => { releaseList = resolve; });
  let lists = 0;
  const fills: Extract<InlineAutofillCommand, { type: 'inline/fill' }>[] = [];
  const releases: (() => void)[] = [];
  let subject: ReturnType<typeof startInlineAutofill>;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') { if (++lists === 1) await blocked; return { ok: true, kind: 'suggestions', status: 'ready', entries }; }
    if (command.type === 'inline/fill') { fills.push(command); await new Promise<void>(resolve => releases.push(resolve)); }
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.option')).toHaveLength(2));
    if (order === 'automatic-first') { releaseList(); await vi.waitFor(() => expect(fills).toHaveLength(1)); }
    root.querySelectorAll<HTMLButtonElement>('.option')[1]!.click();
    await vi.waitFor(() => expect(fills.some(item => item.intent === 'manual')).toBe(true));
    if (order === 'manual-first') { releaseList(); await new Promise(resolve => setTimeout(resolve, 50)); expect(fills).toHaveLength(1); }
    const manual = fills.find(item => item.intent === 'manual')!;
    const old = fills.find(item => item.intent === 'automatic');
    const request = (item: typeof manual) => ({ channel: 'palladin.fill/request' as const, documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: item.intent, loginTargetId: item.loginTargetId, fields: [{ kind: 'totp' as const, value: '123456', expiresAt: Date.now() + 10000, username: item.entryId }] });
    if (old) expect(subject.performFillRequest(request(old)).ok).toBe(false);
    expect(subject.performFillRequest(request(manual)).ok).toBe(true);
  } finally { releaseList(); releases.forEach(resolve => resolve()); subject.stop(); shadow.mockRestore(); }
});

it.each(['second-choice', 'user-edit'])('binds manual OTP replacement to the latest choice and original values (%s)', async scenario => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="one-time-code" value="111111"></form>';
  const entries = ['first', 'second'].map(id => ({ vaultId: 'v1', entryId: id, name: id, username: id, vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' as const }));
  const fills: Extract<InlineAutofillCommand, { type: 'inline/fill' }>[] = [];
  const releases: (() => void)[] = [];
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries };
    if (command.type === 'inline/fill') { fills.push(command); await new Promise<void>(resolve => releases.push(resolve)); }
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    const choose = async (index: number) => { root.querySelector<HTMLButtonElement>('.launcher')!.click(); await vi.waitFor(() => expect(root.querySelectorAll('.option')).toHaveLength(2)); root.querySelectorAll<HTMLButtonElement>('.option')[index]!.click(); };
    await choose(0); await vi.waitFor(() => expect(fills).toHaveLength(1));
    if (scenario === 'second-choice') { await choose(1); await vi.waitFor(() => expect(fills).toHaveLength(2)); }
    else document.querySelector('input')!.value = '222222';
    const request = (item: typeof fills[number]) => ({ channel: 'palladin.fill/request' as const, documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: item.intent, loginTargetId: item.loginTargetId, fields: [{ kind: 'totp' as const, value: '123456', expiresAt: Date.now() + 10000, username: item.entryId }] });
    expect(subject.performFillRequest(request(fills[0]!)).ok).toBe(false);
    if (scenario === 'second-choice') { expect(subject.performFillRequest(request(fills[1]!)).ok).toBe(true); expect(document.querySelector('input')!.value).toBe('123456'); }
    else expect(document.querySelector('input')!.value).toBe('222222');
  } finally { releases.forEach(resolve => resolve()); subject.stop(); shadow.mockRestore(); }
});

it('stops a split OTP write if session lock occurs in an input handler', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form>`;
  let subject: ReturnType<typeof startInlineAutofill>;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries: [{ vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }] };
    if (command.type === 'inline/fill') {
      const outcome = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent, loginTargetId: command.loginTargetId, fields: [{ kind: 'totp', value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }] });
      expect(outcome.ok).toBe(false);
    }
    return { ok: true, kind: 'fill', status: 'blocked' };
  };
  document.querySelector('input')!.addEventListener('input', () => subject.handleSessionChanged('locked'));
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try { await vi.waitFor(() => expect(document.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe('1')); expect(document.querySelectorAll<HTMLInputElement>('input')[1]!.value).toBe(''); }
  finally { subject.stop(); }
});

it('waits for successful manual credential selection before filling OTP in the same form', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  const native = Element.prototype.attachShadow;
  const shadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { return native.call(this, { ...init, mode: 'open' }); });
  document.body.innerHTML = '<form><input autocomplete="username" value="old"><input type="password"><input autocomplete="one-time-code"></form>';
  const entries = [{ vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }];
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let subject: ReturnType<typeof startInlineAutofill>; let otpCalls = 0;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries };
    if (command.type === 'inline/fill') {
      if (command.purpose === 'totp') otpCalls++;
      const fields = command.purpose === 'totp' ? [{ kind: 'totp' as const, value: '123456', expiresAt: Date.now() + 10000, username: 'ada' }]
        : [{ kind: 'username' as const, value: 'ada' }, { kind: 'password' as const, value: 'password' }];
      const outcome = subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent, loginTargetId: command.loginTargetId, fields });
      if (command.intent === 'manual') await wait;
      return { ok: true, kind: 'fill', status: outcome.ok ? 'filled' : 'no-form' };
    }
    return { ok: false, code: 'unavailable' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    const root = document.querySelector('palladin-autofill')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.launcher')!.click();
    await vi.waitFor(() => expect(root.querySelector('.option')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('.option')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[type=password]')!.value).toBe('password'));
    await new Promise(resolve => setTimeout(resolve, 150)); expect(otpCalls).toBe(0);
    release(); await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[autocomplete=one-time-code]')!.value).toBe('123456'));
  } finally { release(); subject.stop(); shadow.mockRestore(); }
});

it.each(['completed', 'pending'])('retries the same OTP control after a same-host SPA URL change (%s)', async phase => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  const entries = [{ vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }];
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let lists = 0, fills = 0;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') { lists++; if (lists === 1 && phase === 'pending') await wait; return { ok: true, kind: 'suggestions', status: 'ready', entries }; }
    if (command.type === 'inline/fill') fills++;
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  const initial = location.href;
  const subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(phase === 'pending' ? lists : fills).toBe(1));
    history.pushState({}, '', '/mfa-step'); document.querySelector('form')!.append(document.createElement('span'));
    await vi.waitFor(() => expect(lists).toBe(2));
    release(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(fills).toBe(phase === 'pending' ? 1 : 2);
    document.querySelector('form')!.append(document.createElement('span'));
    await new Promise(resolve => setTimeout(resolve, 150)); expect(lists).toBe(2);
  } finally { release(); history.replaceState({}, '', initial); subject.stop(); }
});

it('waits for the automatic credential worker reply before starting combined-form OTP', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => 'en' } });
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><input autocomplete="one-time-code"></form>';
  const entries = [{ vaultId: 'v1', entryId: 'e1', name: 'Example', username: 'ada', vaultName: 'Personal', urlDomain: 'example.com', updatedAt: '2026-01-01T00:00:00Z', match: 'exact' }];
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let subject: ReturnType<typeof startInlineAutofill>; let otpCalls = 0;
  const send = async (command: InlineAutofillCommand) => {
    if (command.type === 'inline/list') return { ok: true, kind: 'suggestions', status: 'ready', entries };
    if (command.type === 'inline/fill') {
      if (command.purpose === 'totp') { otpCalls++; return { ok: true, kind: 'fill', status: 'filled' }; }
      subject.performFillRequest({ channel: 'palladin.fill/request', documentId: 'a'.repeat(32), expectedOrigin: 'https://example.com', expectedDomain: 'example.com', submit: false, intent: command.intent, loginTargetId: command.loginTargetId, fields: [{ kind: 'username', value: 'ada' }, { kind: 'password', value: 'password' }] });
      await wait;
    }
    return { ok: true, kind: 'fill', status: 'filled' };
  };
  subject = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[type=password]')!.value).toBe('password'));
    document.querySelector('form')!.append(document.createElement('span'));
    await new Promise(resolve => setTimeout(resolve, 200)); expect(otpCalls).toBe(0);
    release(); await vi.waitFor(() => expect(otpCalls).toBe(1));
  } finally { release(); subject.stop(); }
});
