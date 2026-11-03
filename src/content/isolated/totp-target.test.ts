// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import * as semantics from './totp-target';

afterEach(() => { document.body.innerHTML = ''; });

it('identifies a standalone one-time-code field without reading its value', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  const input = document.querySelector('input')!;
  Object.defineProperty(input, 'value', { get() { throw new Error('discovery read a value'); } });
  const discover = (semantics as unknown as { discoverTotpTargets?: (doc: Document) => unknown[] }).discoverTotpTargets;
  expect(discover?.(document)).toEqual([[input]]);
});

it.each([
  '<form>Code sent by SMS<input autocomplete="one-time-code"></form>',
  '<form>Recovery code<input autocomplete="one-time-code"></form>',
  '<form>Payment code<input autocomplete="one-time-code"></form>',
  '<form>Email verification code<input autocomplete="one-time-code"></form>',
  '<form><input type="number" aria-label="Amount"></form>',
])('rejects unrelated or alternative-delivery controls: %s', html => {
  document.body.innerHTML = html;
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
});

it('discovers labelled authenticator inputs inside open shadow roots without a form', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<div><label>Authenticator code<input></label></div>';
  expect(semantics.discoverTotpTargets(document)).toEqual([[root.querySelector('input')]]);
});

it.each([6, 8])('groups %i one-digit inputs into a single target', count => {
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1" inputmode="numeric">'.repeat(count)}</fieldset></form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([[...document.querySelectorAll('input')]]);
});

it('rejects a target after replacement or a competing OTP field appears', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code"></form>';
  const bound = semantics.discoverTotpTargets(document)[0]!;
  const current = (semantics as unknown as { isCurrentTotpTarget?: (doc: Document, target: HTMLInputElement[]) => boolean }).isCurrentTotpTarget;
  expect(current?.(document, bound)).toBe(true);
  document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input autocomplete="one-time-code">');
  expect(current?.(document, bound)).toBe(false);
  document.querySelectorAll('input')[1]!.remove();
  document.querySelector('input')!.outerHTML = '<input autocomplete="one-time-code">';
  expect(current?.(document, bound)).toBe(false);
});

it('writes a current code once without replacing values or submitting the form', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code"><button>Verify</button></form>';
  const input = document.querySelector('input')!;
  const target = semantics.discoverTotpTargets(document)[0]!;
  let submitted = false; document.querySelector('form')!.addEventListener('submit', e => { e.preventDefault(); submitted = true; });
  const write = (semantics as unknown as { fillTotp?: (doc: Document, target: HTMLInputElement[], code: string, expiresAt: number) => boolean }).fillTotp;
  expect(write?.(document, target, '123456', Date.now() + 10000)).toBe(true);
  expect(input.value).toBe('123456');
  expect(write?.(document, target, '654321', Date.now() + 10000)).toBe(false);
  expect(input.value).toBe('123456');
  expect(submitted).toBe(false);
});

it('rejects expired codes and stops split writes if an event replaces a later control', () => {
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form>`;
  const target = semantics.discoverTotpTargets(document)[0]!;
  const write = (semantics as unknown as { fillTotp?: (doc: Document, target: HTMLInputElement[], code: string, expiresAt: number) => boolean }).fillTotp;
  expect(write?.(document, target, '123456', Date.now() - 1)).toBe(false);
  target[0]!.addEventListener('input', () => { target[1]!.outerHTML = '<input maxlength="1">'; });
  expect(write?.(document, target, '123456', Date.now() + 10000)).toBe(false);
  expect(document.querySelectorAll<HTMLInputElement>('input')[1]!.value).toBe('');
});

it('vetoes a code when a visible login identity differs from the selected account', () => {
  document.body.innerHTML = '<form><input autocomplete="username" value="other@example.test"><input autocomplete="one-time-code"></form>';
  const target = semantics.discoverTotpTargets(document)[0]!;
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000, 'chosen@example.test')).toBe(false);
  expect(target[0]!.value).toBe('');
});

it('detects a combined authenticator form with an email username label', () => {
  document.body.innerHTML = '<form><label>Email <input autocomplete="username"></label><input type="password"><label>Authenticator code<input autocomplete="one-time-code"></label></form>';
  expect(semantics.discoverTotpTargets(document)).toEqual([[document.querySelector('input[autocomplete="one-time-code"]')]]);
});

it('allows explicit choice of one known target when two OTP fields are present', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code"><input autocomplete="one-time-code"></form>';
  const target = semantics.discoverTotpTargets(document)[1]!;
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000, '', true)).toBe(true);
  expect(document.querySelectorAll<HTMLInputElement>('input')[0]!.value).toBe('');
  expect(target[0]!.value).toBe('123456');
});

it('stops split writes if the page hides a later digit during input', () => {
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form>`;
  const target = semantics.discoverTotpTargets(document)[0]!;
  target[0]!.addEventListener('input', () => { target[1]!.hidden = true; });
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000)).toBe(false);
  expect(target[1]!.value).toBe('');
});

it('vetoes a different visible identity in the same formless login scope', () => {
  document.body.innerHTML = '<section><label>Email<input autocomplete="username" value="other@example.test"></label><label>Authenticator code<input autocomplete="one-time-code"></label></section>';
  const target = semantics.discoverTotpTargets(document)[0]!;
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000, 'chosen@example.test')).toBe(false);
  expect(target[0]!.value).toBe('');
});

it('fills an identified OTP control directly in a formless body', () => {
  document.body.innerHTML = '<input autocomplete="one-time-code">';
  const target = semantics.discoverTotpTargets(document)[0]!;
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000)).toBe(true);
});

it('rejects explicit SMS delivery in the enclosing formless scope', () => {
  document.body.innerHTML = '<section>Code sent by SMS<label>Verification code<input autocomplete="one-time-code"></label></section>';
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
});

it.each(['Use a recovery code', 'Try SMS instead'])('ignores an alternative method link: %s', action => {
  document.body.innerHTML = `<form><label>Authenticator code<input autocomplete="one-time-code"></label><a href="#">${action}</a></form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([[document.querySelector('input')]]);
});

it('ignores hidden competing OTP controls during discovery', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code"><input autocomplete="one-time-code" hidden></form>';
  expect(semantics.discoverTotpTargets(document)).toEqual([[document.querySelector('input:not([hidden])')]]);
});

it.each([6, 8])('accepts a coherent autocomplete-only %i digit group', count => {
  document.body.innerHTML = `<form>${'<input maxlength="1" inputmode="numeric" autocomplete="one-time-code">'.repeat(count)}</form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([[...document.querySelectorAll('input')]]);
});

it('rejects mixed autocomplete split groups and explicit SMS delivery', () => {
  document.body.innerHTML = `<form>${'<input maxlength="1" autocomplete="one-time-code">'.repeat(5)}<input maxlength="1"></form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
  document.body.innerHTML = `<form>Code sent by SMS${'<input maxlength="1" autocomplete="one-time-code">'.repeat(6)}</form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
});

it.each(['scope', 'url'])('stops split writes if %s changes during input', change => {
  document.body.innerHTML = `<form id="a"><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form><form id="b"></form>`;
  const target = semantics.discoverTotpTargets(document)[0]!;
  const initialUrl = location.href;
  target[0]!.addEventListener('input', () => {
    if (change === 'scope') document.querySelector('#b')!.append(document.querySelector('fieldset')!);
    else history.pushState({}, '', '/changed');
  });
  try {
    expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000)).toBe(false);
    expect(target[1]!.value).toBe('');
  } finally { history.replaceState({}, '', initialUrl); }
});

it('allows an explicit manual replacement of an existing OTP', () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code" value="111111"></form>';
  const target = semantics.discoverTotpTargets(document)[0]!;
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000, '', true)).toBe(true);
  expect(target[0]!.value).toBe('123456');
});

it('rejects a split group containing a conflicting autocomplete purpose even under an authenticator legend', () => {
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1" autocomplete="one-time-code">'.repeat(5)}<input maxlength="1" autocomplete="cc-csc"></fieldset></form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
});

it('stops split writes when the operation is superseded during an input event', () => {
  document.body.innerHTML = `<form><fieldset><legend>Authenticator code</legend>${'<input maxlength="1">'.repeat(6)}</fieldset></form>`;
  const target = semantics.discoverTotpTargets(document)[0]!;
  const binding = semantics.bindTotpTarget(document, target);
  let current = true;
  target[0]!.addEventListener('input', () => { current = false; });
  expect(semantics.fillTotp(document, target, '123456', Date.now() + 10000, '', false, binding, () => current)).toBe(false);
  expect(target[1]!.value).toBe('');
});

it('rejects a split group spanning different autocomplete sections', () => {
  document.body.innerHTML = `<form>${'<input maxlength="1" autocomplete="section-a one-time-code">'.repeat(3)}${'<input maxlength="1" autocomplete="section-b one-time-code">'.repeat(3)}</form>`;
  expect(semantics.discoverTotpTargets(document)).toEqual([]);
});
