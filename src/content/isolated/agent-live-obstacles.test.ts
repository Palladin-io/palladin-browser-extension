// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { AGENT_INJECT_STEP_CHANNEL } from '@shared/messaging';
const documentId = 'd'.repeat(32), url = 'https://login.example.test/';
const dom = { isVisible: (element: HTMLElement) => !element.hidden && !element.closest('[hidden]') };
const login = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>';
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); document.body.replaceChildren(); });
function setup(html: string) {
  document.body.innerHTML = html;
  live = new LiveLogin(document, documentId, () => url, () => true, dom);
  return live;
}
it('prepares the observed Allegro login despite a separately observed outside-form advertising iframe', () => {
  const instance = setup(readFileSync('tests/fixtures/forms/allegro-login-ad-2026-09-20/page.html', 'utf8'));
  const plan = instance.inspect(url);
  expect(plan?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
  const submitted = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submitted);
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'login.example.test', step: plan!.steps[0]!,
    values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }, { entryFieldId: 'credential.password', value: 'Synthetic-only!42' }] })).toEqual({ ok: true });
  expect(submitted).toHaveBeenCalledTimes(1);
});
it.each(['<div role="combobox"></div>', '<div contenteditable="true"></div>'])('ignores an unrelated custom control: %s', widget => {
  expect(setup(login + widget).probe(url).outcome).toBe('ready');
});
it('does not inspect an alternative iframe beside a complete native form', () => {
  const instance = setup(login.replace('<form>', '<form><iframe title="Alternative sign in"></iframe>'));
  const frame = document.querySelector('iframe')!;
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Must not inspect frame contents'); } });
  Object.defineProperty(frame, 'contentWindow', { get() { throw new Error('Must not inspect frame contents'); } });
  expect(instance.probe(url).outcome).toBe('ready');
});
it.each(['<div data-sitekey="synthetic"></div>', '<iframe title="CAPTCHA challenge"></iframe>', '<div role="combobox"></div>', '<div contenteditable="true"></div>'])('rejects an obstacle in the selected scope: %s', obstacle => {
  expect(setup(login.replace('<form>', `<form>${obstacle}`)).probe(url)).toEqual({ outcome: 'challenge' });
});
it('keeps an explicit challenge outside the form blocking', () => {
  expect(setup(login + '<div data-sitekey="synthetic"></div>').probe(url)).toEqual({ outcome: 'challenge' });
});
it('does not discover credentials owned only by an iframe', () => {
  expect(setup('<iframe title="Sign in"></iframe>').probe(url)).toEqual({ outcome: 'challenge' });
});
it('never chooses between two native credential forms', () => {
  expect(setup(login + login).inspect(url)).toBeNull();
});
it('still rejects controls covered by an overlay at discovery', () => {
  document.body.innerHTML = login;
  live = new LiveLogin(document, documentId, () => url, () => true, { isVisible: element => !element.matches('input') });
  expect(live.inspect(url)).toBeNull();
});
