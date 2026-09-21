// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://accounts.example.test/login"}
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialSubmissionObserver, readSubmittedCredential } from './credential-submission';
import { markAgentManagedControl } from './agent-managed-controls';
let observer: CredentialSubmissionObserver | undefined;
afterEach(() => { observer?.stop(); observer = undefined; document.body.replaceChildren(); vi.useRealTimers(); });
function form(markup: string) { document.body.innerHTML = `<form>${markup}<button>Continue</button></form>`; return document.querySelector('form')!; }
it('uses shared password roles instead of position for unannotated current/new/confirmation controls', () => {
  const target = form('<input autocomplete="username" value="synthetic-user"><label>New password<input type="password" value="replacement"></label><label>Confirm password<input type="password" value="replacement"></label><label>Current password<input type="password" value="previous"></label>');
  expect(readSubmittedCredential(target)).toEqual({ kind: 'password-change', username: 'synthetic-user', password: 'replacement', previousPassword: 'previous' });
});
it('captures the observed X password stage with its disabled explicit carried identity', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/x-deferred-password-2026-09-20.html', 'utf8');
  document.querySelector<HTMLInputElement>('[autocomplete=username]')!.value = 'synthetic-user';
  document.querySelector<HTMLInputElement>('[autocomplete=current-password]')!.value = 'Synthetic-password!42';
  expect(readSubmittedCredential(document.querySelector('form')!)).toEqual({ kind: 'login', username: 'synthetic-user', password: 'Synthetic-password!42', previousPassword: null });
});
it('stages the observed X identifier despite its inactive password control', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/x-deferred-login-2026-09-20.html', 'utf8');
  document.querySelector<HTMLInputElement>('[name=username_or_email]')!.value = 'synthetic-user';
  const send = vi.fn(); observer = new CredentialSubmissionObserver(document, 'synthetic-document', send);
  observer.capture(document.querySelector('form')!);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'identifier', username: 'synthetic-user' }));
});
it('reads native-form controls across an open component and rejects agent-managed controls before values', () => {
  const target = form('<public-fields></public-fields>');
  const root = target.querySelector('public-fields')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<input autocomplete="username" value="synthetic-user"><input type="password" autocomplete="current-password" value="synthetic-password">';
  expect(readSubmittedCredential(target)?.username).toBe('synthetic-user');
  root.querySelectorAll('input').forEach(input => { markAgentManagedControl(input); Object.defineProperty(input, 'value', { get() { throw new Error('Agent value must not be read'); } }); });
  expect(readSubmittedCredential(target)).toBeNull();
});
it('observes later open-shadow errors without treating a replacement shadow password as success', async () => {
  vi.useFakeTimers(); const send = vi.fn(); observer = new CredentialSubmissionObserver(document, 'synthetic-document', send); observer.start();
  const target = form('<public-fields></public-fields>'); const root = target.querySelector('public-fields')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<input autocomplete="username" value="synthetic"><input type="password" value="synthetic-password">';
  observer.capture(target); await vi.advanceTimersByTimeAsync(800); expect(send).toHaveBeenCalledTimes(1);
  root.querySelector('input[type=password]')!.replaceWith(Object.assign(document.createElement('input'), { type: 'password' }));
  await vi.advanceTimersByTimeAsync(800); expect(send).toHaveBeenCalledTimes(1);
  const error = document.createElement('div'); error.setAttribute('role', 'alert'); error.textContent = 'Incorrect password'; root.append(error);
  await vi.advanceTimersByTimeAsync(800); expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'rejected' }));
});
it('does not postpone outcome indefinitely when unrelated SPA content keeps changing', async () => {
  vi.useFakeTimers(); const send = vi.fn(); observer = new CredentialSubmissionObserver(document, 'synthetic-document', send); observer.start();
  const target = form('<input autocomplete="username" value="synthetic"><input type="password" value="synthetic-password">');
  observer.capture(target); target.remove();
  for (let i = 0; i < 10; i++) { document.body.className = `synthetic-${i}`; await vi.advanceTimersByTimeAsync(100); }
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'form-dismissed' }));
});
it.each(['<input type="hidden" name="csrf" value="synthetic-token">','<input type="hidden" autocomplete="username" placeholder="Verification code" value="123456">','<input hidden autocomplete="username" value="a"><input hidden autocomplete="username" value="b">'])('rejects arbitrary hidden, OTP, or ambiguous carried identities', identity => {
  expect(readSubmittedCredential(form(identity + '<input type="password" value="synthetic-password">'))).toBeNull();
});
it('keeps the observed signup email and nickname available for explicit selection', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/doradcasmaku-capture-2026-09-16/page.html', 'utf8');
  document.querySelector<HTMLInputElement>('[name=nickname]')!.value = 'synthetic-nickname';
  document.querySelector<HTMLInputElement>('[name=email]')!.value = 'synthetic@example.test';
  document.querySelectorAll<HTMLInputElement>('[type=password]').forEach(field => { field.value = 'Synthetic-password42'; });
  expect(readSubmittedCredential(document.querySelector('form')!)).toEqual({ kind: 'registration', username: '', password: 'Synthetic-password42', previousPassword: null, usernameOptions: { email: 'synthetic@example.test', nickname: 'synthetic-nickname' } });
});
it('does not mistake a confirmation email or subscription control for carried identity', () => {
  for (const extra of ['name="newsletter"', 'placeholder="Confirm email"']) {
    expect(readSubmittedCredential(form(`<input disabled autocomplete="username" ${extra} value="synthetic"><input type="password" value="synthetic-password">`))).toBeNull();
  }
});
it('rejects unequal confirmation email values', () => {
  expect(readSubmittedCredential(form('<input type="email" value="one@example.test"><input type="email" placeholder="Confirm email" value="two@example.test"><input type="password" autocomplete="new-password" value="synthetic-password">'))).toBeNull();
});
it('releases observer subscriptions to removed open roots and observes replacement components', async () => {
  vi.useFakeTimers(); const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const target = form('<public-fields></public-fields>'); const host = target.querySelector('public-fields')!;
  host.attachShadow({ mode: 'open' }).innerHTML = '<input autocomplete="username" value="synthetic"><input type="password" value="synthetic-password">';
  observer = new CredentialSubmissionObserver(document, 'synthetic-document', vi.fn()); observer.start();
  host.remove(); await vi.advanceTimersByTimeAsync(0);
  expect(disconnect).toHaveBeenCalledTimes(1);
  disconnect.mockRestore();
});
it('offers email or a uniquely labelled nickname even when email wins ordinary login discovery', () => {
  const target = form('<label>Email<input type="email" name="email" autocomplete="email" value="synthetic@example.test"></label><label>Nickname<input name="nickname" value="synthetic-handle"></label><label>Password<input type="password" name="password" autocomplete="new-password" value="synthetic-password"></label><label>Confirm password<input type="password" name="confirm" autocomplete="new-password" value="synthetic-password"></label>');
  expect(readSubmittedCredential(target)).toEqual({ kind: 'registration', username: '', password: 'synthetic-password', previousPassword: null,
    usernameOptions: { email: 'synthetic@example.test', nickname: 'synthetic-handle' } });
});
it('keeps an explicitly annotated username authoritative beside email and nickname', () => {
  const target = form('<input autocomplete="username" value="approved-login"><label>Nickname<input name="nickname" value="public-handle"></label><input type="email" value="synthetic@example.test"><input type="password" autocomplete="new-password" value="synthetic-password">');
  expect(readSubmittedCredential(target)).toEqual({ kind: 'registration', username: 'approved-login', password: 'synthetic-password', previousPassword: null });
});
it('does not offer a personal-name field as nickname when its declared purpose conflicts', () => {
  const target = form('<label>Nickname<input name="nickname" autocomplete="given-name" value="synthetic-name"></label><input type="email" value="synthetic@example.test"><input type="password" autocomplete="new-password" value="synthetic-password">');
  expect(readSubmittedCredential(target)).toEqual({ kind: 'registration', username: 'synthetic@example.test', password: 'synthetic-password', previousPassword: null });
});
