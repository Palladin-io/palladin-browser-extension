// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://podketo.pl/pl/signin.html"}
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { isCaptureVisible } from './credential-submission';
import { loginTargetFor, performLoginTargetFill } from './fill';

const specimen = readFileSync('tests/fixtures/forms/podketo-login-2026-10-27/page.html', 'utf8');
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
beforeEach(() => { document.body.innerHTML = specimen; });
afterEach(() => { document.body.replaceChildren(); });

it('recognizes the observed Podketo login and fills only its owning pair without submitting', () => {
  const target = loginTargetFor(input('user_login'));
  expect(target?.username).toBe(input('user_login'));
  expect(target?.password).toBe(input('user_pass'));
  let submitted = false;
  input('user_login').form!.addEventListener('submit', event => { event.preventDefault(); submitted = true; });
  expect(performLoginTargetFill(target!, [
    { kind: 'username', value: 'synthetic@example.test' },
    { kind: 'password', value: 'Synthetic-only!42' },
  ])).toEqual({ ok: true });
  expect(input('user_login').value).toBe('synthetic@example.test');
  expect(input('user_pass').value).toBe('Synthetic-only!42');
  expect(submitted).toBe(false);
  expect(loginTargetFor(input('user_pass'))).toBeNull();
});

it.each(['hidden', 'registration', 'otp', 'foreign-form'])('rejects the synthetic %s counterexample', variant => {
  if (variant === 'hidden') input('user_pass').hidden = true;
  if (variant === 'registration') input('user_pass').autocomplete = 'new-password';
  if (variant === 'otp') input('user_login').autocomplete = 'one-time-code';
  if (variant === 'foreign-form') input('user_pass').setAttribute('form', 'missing-owner');
  const target = loginTargetFor(input('user_login'));
  expect(target?.password ?? null).toBeNull();
});

it('does not overwrite an existing identity during automatic fill', () => {
  input('user_login').value = 'existing@example.test';
  const target = loginTargetFor(input('user_login'))!;
  const result = performLoginTargetFill(target, [
    { kind: 'username', value: 'synthetic@example.test' },
    { kind: 'password', value: 'Synthetic-only!42' },
  ]);
  expect(result.ok).toBe(false);
  expect(input('user_login').value).toBe('existing@example.test');
  expect(input('user_pass').value).toBe('');
});

it('exposes the same pair to Agent discovery without executing a login', () => {
  const live = new LiveLogin(document, 'a'.repeat(32), () => window.location.href, () => true, { isVisible: isCaptureVisible });
  try {
    const form = live.inspect(window.location.href);
    expect(form).not.toBeNull();
    expect(form!.steps[0]!.fields.map(field => field.entryFieldId)).toEqual(['credential.username', 'credential.password']);
  } finally { live.clear(); }
});

it('ignores the observed homepage search and newsletter before navigation to login', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/podketo-login-2026-10-27/home.html', 'utf8');
  expect([...document.querySelectorAll('input')].map(loginTargetFor).filter(Boolean)).toHaveLength(0);
});
