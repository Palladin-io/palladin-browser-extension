// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://forms.example.test/login"}
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { isCaptureVisible } from './credential-submission';

const url = 'https://forms.example.test/login', documentId = 'd'.repeat(32);
const replay = new Function(readFileSync('scripts/replay-form-specimen.mjs', 'utf8').replaceAll('export function', 'function')
  + '; return hydrateFormSpecimen;')() as (root: Element, css: string) => void;
let live: LiveLogin | undefined;
afterEach(() => {
  live?.clear(); document.body.replaceChildren();
  document.head.querySelectorAll('[data-corpus-style]').forEach(node => node.remove());
  vi.useRealTimers();
});
function instance() { return live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: isCaptureVisible }); }

// These specimens prove initial discovery only: their post-input activation was
// not observed and must not be fabricated into a production replay PASS.
it.each(['fandom-login-2026-09-15', 'filmweb-login-2026-09-15', 'twitch-login-2026-09-15', 'gazeta-login-2026-09-16'])(
  'prepares both recorded credential fields without enabling or clicking %s', id => {
    const base = `tests/fixtures/forms/${id}`;
    document.body.innerHTML = readFileSync(`${base}/page.html`, 'utf8');
    const style = document.createElement('style'); style.dataset.corpusStyle = '';
    style.textContent = readFileSync(`${base}/page.css`, 'utf8'); document.head.append(style);
    replay(document.body, style.textContent);
    const disabled = [...document.querySelectorAll<HTMLButtonElement>('button:disabled')];
    expect(disabled.length).toBeGreaterThan(0);
    const click = vi.fn(); disabled.forEach(button => button.addEventListener('click', click));
    const form = instance().inspect(url);
    expect(form?.version).toBe(2);
    expect(form?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
    expect(disabled.every(button => button.disabled)).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

const synthetic = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button disabled>Sign in</button></form>';
function setup(html = synthetic) { document.body.innerHTML = html; return instance(); }
async function fill(flow: LiveLogin) {
  const form = flow.inspect(url); expect(form).not.toBeNull(); if (!form) return null;
  return flow.fillDeferred({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId,
    expectedDomain: 'forms.example.test', expiresAt: Date.now() + 10_000, form,
    values: [{ entryFieldId: 'credential.username', value: 'fixture@example.test' }, { entryFieldId: 'credential.password', value: 'Fixture-only!42' }] });
}

// Generic synthetic framework behavior, deliberately separate from the cases above.
it('waits for framework activation after both writes and requires one separate commit', async () => {
  const flow = setup(), button = document.querySelector('button')!;
  const submitted = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submitted);
  document.querySelector('form')!.addEventListener('input', () => {
    button.disabled = [...document.querySelectorAll('input')].some(input => !input.value);
  });
  const ready = await fill(flow); expect(ready?.ok).toBe(true); if (!ready?.ok) return;
  expect(submitted).not.toHaveBeenCalled();
  const commit = { channel: 'palladin.agent-live/deferred-commit' as const, expectedDomain: 'forms.example.test',
    submitReady: ready.submitReady, expiresAt: Date.now() + 1000 };
  expect(flow.commitDeferred(commit).ok).toBe(true);
  expect(flow.commitDeferred(commit).ok).toBe(false);
  expect(submitted).toHaveBeenCalledTimes(1);
});

it('never enables a persistently disabled button and wipes its writes on timeout', async () => {
  vi.useFakeTimers(); const flow = setup(), button = document.querySelector('button')!, click = vi.fn();
  button.addEventListener('click', click);
  const pending = fill(flow); await vi.advanceTimersByTimeAsync(5_001);
  expect((await pending)?.ok).toBe(false);
  expect(button.disabled).toBe(true); expect(click).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('input')].every(input => input.value === '')).toBe(true);
});

it.each([
  synthetic.replace('current-password', 'new-password'),
  synthetic.replace('<form>', '<form><h2>Create account</h2>'),
  synthetic.replace('<button', '<input autocomplete="one-time-code"><button'),
  synthetic.replace('<button', '<input name="account"><button'),
  synthetic.replace('<button', '<input autocomplete="username" disabled><button'),
  synthetic.replace('<button', '<input type="password" hidden><button'),
  synthetic.replace('Sign in', 'Create account'),
  synthetic.replace('<button disabled>Sign in</button>', '<div>Continue</div>'),
  synthetic.replace('</form>', '<button disabled>Continue</button></form>'),
  synthetic + synthetic,
])('rejects ambiguous or unsupported combined stages', html => { expect(setup(html).inspect(url)).toBeNull(); });

it.each(['disabled', 'foreign-action', 'extra-field', 'replacement'])('rejects a changed %s before commit', async mutation => {
  const flow = setup(), button = document.querySelector('button')!, clicked = vi.fn((event: Event) => event.preventDefault());
  button.addEventListener('click', clicked);
  document.querySelector('form')!.addEventListener('input', () => { button.disabled = false; });
  const ready = await fill(flow); expect(ready?.ok).toBe(true); if (!ready?.ok) return;
  if (mutation === 'disabled') button.disabled = true;
  if (mutation === 'foreign-action') document.querySelector('form')!.action = 'https://other.example.test';
  if (mutation === 'extra-field') document.querySelector('form')!.insertAdjacentHTML('afterbegin', '<input name="other">');
  if (mutation === 'replacement') button.replaceWith(button.cloneNode(true));
  expect(flow.commitDeferred({ channel: 'palladin.agent-live/deferred-commit', expectedDomain: 'forms.example.test',
    submitReady: ready.submitReady, expiresAt: Date.now() + 1000 }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
});
