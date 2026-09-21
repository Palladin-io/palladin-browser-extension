// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://forms.example.test/login"}
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { isCaptureVisible } from './credential-submission';
import { hasLoginActionLabel } from './login-controls';

const documentId = 'd'.repeat(32);
const url = 'https://forms.example.test/login';
const replay = new Function(readFileSync('scripts/replay-form-specimen.mjs', 'utf8').replaceAll('export function', 'function')
  + '; return hydrateFormSpecimen;')() as (root: Element, css: string) => void;
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); document.body.replaceChildren(); document.head.querySelectorAll('[data-corpus-style]').forEach(node => node.remove()); });
function instance() { return live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: isCaptureVisible }); }

// HTML and CSS remain the observed production specimens. Values and click
// counters below are synthetic; no production submit behavior is claimed.
it.each([
  '24ur-login-2026-09-15', 'bankier-login-2026-09-15',
  'record-login-2026-09-16',
  'tv2-login-2026-09-16', 'rte-login-2026-09-15',
  'amazon-login-identifier-2026-09-15',
])('uses the observed localized/input action for %s', async id => {
  const base = `tests/fixtures/forms/${id}`;
  document.body.innerHTML = readFileSync(`${base}/page.html`, 'utf8');
  const style = document.createElement('style'); style.dataset.corpusStyle = '';
  style.textContent = readFileSync(`${base}/page.css`, 'utf8'); document.head.append(style);
  replay(document.body, style.textContent);
  if (id.startsWith('amazon-')) expect(hasLoginActionLabel(document.querySelector('input[type=submit]')!)).toBe(true);
  const clicks = vi.fn((event: Event) => event.preventDefault());
  document.addEventListener('click', clicks);
  try {
    const flow = instance(); const form = flow.inspect(url);
    expect(form, 'Production-observed native login action should be recognized').not.toBeNull();
    if (!form) return;
    const values = form.steps[0]!.fields.map(field => ({ entryFieldId: field.entryFieldId,
      value: field.entryFieldId === 'credential.password' ? 'Fixture-only-password!42' : 'fixture-user@example.test' }));
    const ready = await flow.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
      expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form, values });
    expect(ready.ok).toBe(true); expect(clicks).not.toHaveBeenCalled(); if (!ready.ok) return;
    expect(flow.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
      submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  } finally { document.removeEventListener('click', clicks); }
});

it.each(['Continue with Google', 'Create account', 'Reset password', 'Delete account'])('does not execute %s as a login action', caption => {
  document.body.innerHTML = `<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>${caption}</button></form>`;
  expect(instance().inspect(url)).toBeNull();
});

it('uses an explicit accessible native action label, but rejects a changed label before commit', async () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button aria-label="Sign in"><span>→</span></button></form>';
  const flow = instance(), form = flow.inspect(url);
  expect(form).not.toBeNull(); if (!form) return;
  const click = vi.fn((event: Event) => event.preventDefault()); document.querySelector('button')!.addEventListener('click', click);
  const ready = await flow.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture@example.test' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector('button')!.setAttribute('aria-label', 'Continue');
  expect(flow.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
    submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(click).not.toHaveBeenCalled();
});

it.each(['Delete account', 'Create account'])('never treats a %s button payload as its login caption', caption => {
  document.body.innerHTML = `<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button type="submit" value="submit">${caption}</button></form>`;
  expect(instance().inspect(url)).toBeNull();
});

it('uses the complete aria-labelledby caption rather than individual matching words', () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><input type="submit" aria-labelledby="action provider"><span id="action">Continue</span><span id="provider">with Google</span></form>';
  expect(instance().inspect(url)).toBeNull();
  document.querySelector('#provider')!.remove();
  expect(instance().inspect(url)).toBeNull();
});

it('binds referenced action text across fill and commit', async () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><input type="submit" aria-labelledby="caption"><span id="caption" aria-hidden="true">Sign in</span></form>';
  const flow = instance(), form = flow.inspect(url); expect(form).not.toBeNull(); if (!form) return;
  const clicked = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('input[type=submit]')!.addEventListener('click', clicked);
  const ready = await flow.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture@example.test' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  document.querySelector('#caption')!.textContent = 'Continue';
  expect(flow.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
    submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
});

it.each(['button', 'input'])('also binds the original visible/public %s caption when aria-labelledby is unchanged', async tag => {
  const actionHtml = tag === 'button' ? '<button aria-labelledby="caption">Sign in</button>'
    : '<input type="submit" aria-labelledby="caption" value="Sign in">';
  document.body.innerHTML = `<form><input autocomplete="username"><input type="password">${actionHtml}<span id="caption">Sign in</span></form>`;
  const flow = instance(), form = flow.inspect(url); expect(form).not.toBeNull(); if (!form) return;
  const action = document.querySelector<HTMLElement>('[aria-labelledby]')!, clicked = vi.fn((event: Event) => event.preventDefault());
  action.addEventListener('click', clicked);
  const ready = await flow.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture@example.test' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
  expect(ready.ok).toBe(true); if (!ready.ok) return;
  if (action instanceof HTMLInputElement) action.value = 'Delete account'; else action.textContent = 'Delete account';
  expect(flow.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
    submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
});

it('never reads a referenced control value as a public caption', () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password" id="caption"><input type="submit" aria-labelledby="caption"></form>';
  const field = document.querySelector('#caption')!;
  Object.defineProperty(field, 'value', { get: () => { throw new Error('Must not read credential value'); } });
  expect(hasLoginActionLabel(document.querySelector('input[type=submit]')!)).toBe(false);
});

it('resolves ID references only within the control tree and uses the whole accessible caption', () => {
  document.body.innerHTML = '<span id="caption">Delete account</span><div id="host"></div>';
  const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<input type="submit" value="Continue" aria-labelledby="caption"><span id="caption">Sign in</span>';
  const action = root.querySelector('input')!;
  expect(hasLoginActionLabel(action)).toBe(true);
  root.querySelector('span')!.textContent = 'Delete account';
  expect(hasLoginActionLabel(action)).toBe(false);
  root.querySelector('span')!.remove();
  document.querySelector('#caption')!.textContent = 'Continue';
  expect(hasLoginActionLabel(action)).toBe(false);
});

it.each(['', 'missing', Array(9).fill('caption').join(' '), 'x'.repeat(513)])('rejects empty, unresolved or excessive action references: %s', references => {
  document.body.innerHTML = '<input type="submit" value="Continue"><span id="caption">Continue</span>';
  const action = document.querySelector('input')!; action.setAttribute('aria-labelledby', references);
  expect(hasLoginActionLabel(action)).toBe(false);
});

// The captured Aftonbladet state precedes any identifier input. Its activation
// was not observed; this boundary check does not count as a complete Agent flow.
it('recognizes Aftonbladet text without activating its observed disabled action', () => {
  const base = 'tests/fixtures/forms/aftonbladet-login-identifier-2026-09-16';
  document.body.innerHTML = readFileSync(`${base}/page.html`, 'utf8');
  const action = document.querySelector<HTMLButtonElement>('#continue-button')!;
  const click = vi.fn(); action.addEventListener('click', click);
  expect(hasLoginActionLabel(action)).toBe(true);
  expect(action.disabled).toBe(true);
  instance().inspect(url);
  expect(action.disabled).toBe(true); expect(click).not.toHaveBeenCalled();
});
