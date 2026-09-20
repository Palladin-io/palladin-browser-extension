// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { loginTargetFor, submitLoginForm } from './fill';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('runs the observed AWS Next button click handler instead of the default GET submit', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-20/page.html', 'utf8');
  const input = document.querySelector<HTMLInputElement>('#resolving_input')!;
  input.value = 'synthetic@example.test';
  const form = input.form!;
  const next = form.querySelector<HTMLButtonElement>('#next_button')!;
  expect(next.type).toBe('submit');
  expect(form.getAttribute('method')).toBeNull();
  // Captured structure, synthetic framework event behavior. No production JS.
  const advance = vi.fn(); const defaultSubmit = vi.fn();
  next.addEventListener('click', event => { event.preventDefault(); advance(); });
  form.addEventListener('submit', event => { event.preventDefault(); defaultSubmit(); });
  expect(submitLoginForm(input, loginTargetFor(input)!)).toBe(true);
  expect(advance).toHaveBeenCalledTimes(1);
  expect(defaultSubmit).not.toHaveBeenCalled();
});

it.each(['', 'method="get"', 'method="post"'])('prevents credential serialization into a default GET (%s)', attributes => {
  document.body.innerHTML = `<form ${attributes}><input id="username" name="username" autocomplete="username"><input name="password" type="password"><button type="submit" ${attributes.includes('post') ? 'formmethod="get"' : ''}>Sign in</button></form>`;
  const input = document.querySelector<HTMLInputElement>('#username')!;
  input.value = 'synthetic@example.test';
  document.querySelector<HTMLInputElement>('[type=password]')!.value = 'synthetic-only';
  const events: Event[] = [];
  document.querySelector('form')!.addEventListener('submit', event => { events.push(event); });
  expect(submitLoginForm(input)).toBe(true);
  expect(events.map(event => event.defaultPrevented)).toEqual([true]);
});


it('preserves a framework submit handler on an omitted-method SPA without claiming authentication', () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>';
  const accepted = vi.fn();
  document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); accepted(); });
  expect(submitLoginForm(document.querySelector('input')!)).toBe(true);
  expect(accepted).toHaveBeenCalledTimes(1);
});

it.each(['button', 'submit', 'implicit', 'input'])('clicks the unique form-owned native %s and respects native validation', kind => {
  const button = kind === 'input' ? '<input id="go" type="submit" value="Next">'
    : `<button id="go" ${kind === 'implicit' ? '' : `type="${kind}"`}>Next</button>`;
  document.body.innerHTML = `<form method="post"><input required id="user" autocomplete="username">${button}</form>`;
  const form = document.querySelector('form')!; const input = document.querySelector<HTMLInputElement>('#user')!;
  const clicked = vi.fn(); const submitted = vi.fn();
  document.querySelector('#go')!.addEventListener('click', clicked);
  form.addEventListener('submit', event => { event.preventDefault(); submitted((event as SubmitEvent).submitter); });
  expect(submitLoginForm(input)).toBe(true);
  expect(clicked).toHaveBeenCalledTimes(1); expect(submitted).not.toHaveBeenCalled();
  input.value = 'synthetic'; expect(submitLoginForm(input)).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(kind === 'button' ? 0 : 1);
});

it.each([
  '<button type="submit" hidden>Next</button>',
  '<fieldset disabled><button type="submit">Next</button></fieldset>',
  '<button type="submit" aria-disabled="true">Next</button>',
  '<button type="submit" form="other">Next</button>',
  '<button type="submit">Sign in</button><button type="submit">Continue</button>',
  '<button type="button">Sign up</button>',
  '<button type="button">Continue with Google</button>',
  '<div role="button">Continue</div>',
  '',
])('fails closed for absent, unusable, unrelated or ambiguous actions: %s', markup => {
  document.body.innerHTML = `<form id="login"><input autocomplete="username"><input type="password">${markup}</form><form id="other"></form>`;
  const click = vi.spyOn(HTMLElement.prototype, 'click');
  expect(submitLoginForm(document.querySelector('input')!)).toBe(false);
  expect(click).not.toHaveBeenCalled();
});

it('selects an external submit control only for its explicit native form owner', () => {
  document.body.innerHTML = '<form id="login" method="post"><input autocomplete="username"><input type="password"></form><button form="login" type="submit">Next</button>';
  const submit = vi.fn();
  document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submit(); });
  expect(submitLoginForm(document.querySelector('input')!)).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
});

it('blocks a non-composed default GET submit inside an open shadow root', () => {
  const host = document.createElement('section'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<form><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>';
  const events: Event[] = [];
  root.querySelector('form')!.addEventListener('submit', event => { events.push(event); });
  const input = root.querySelector('input')!;
  expect(submitLoginForm(input, loginTargetFor(input)!)).toBe(true);
  expect(events.map(event => event.defaultPrevented)).toEqual([true]);
});

it('does not leave a guard installed after its one explicit native click', () => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>';
  const form = document.querySelector('form')!;
  const events: Event[] = [];
  form.addEventListener('submit', event => { events.push(event); });
  expect(submitLoginForm(document.querySelector('input')!)).toBe(true);
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  expect(events.map(event => event.defaultPrevented)).toEqual([true, false]);
});


it.each(['Fortsett', 'Fortsätt', 'Continuar', 'Συνέχεια', 'Logowanie'])('retains the canonical formless login action %s', caption => {
  document.body.innerHTML = `<section><input autocomplete="username"><input type="password"><button type="button">${caption}</button></section>`;
  const input = document.querySelector('input')!;
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
  expect(submitLoginForm(input, loginTargetFor(input)!)).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
});

it.each(['<button type="button" aria-label="Continue"><svg></svg></button>', '<input type="button" value="Fortsett">'])('recognizes native action accessibility/value labels: %s', action => {
  document.body.innerHTML = `<section><input id="username" autocomplete="username"><input type="password">${action}</section>`;
  const input = document.querySelector<HTMLInputElement>('#username')!;
  const click = vi.fn(); document.querySelector('button, [type=button]')!.addEventListener('click', click);
  expect(submitLoginForm(input, loginTargetFor(input)!)).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
});

it.each(['Sign up', 'Register', 'Create account', 'Konto erstellen', 'Continue with Google'])('does not treat the discovery caption %s as an executable login fallback', caption => {
  document.body.innerHTML = `<section><input autocomplete="username"><input type="password"><button type="button" aria-label="${caption}"></button></section>`;
  const input = document.querySelector('input')!;
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
  expect(submitLoginForm(input, loginTargetFor(input)!)).toBe(false);
  expect(click).not.toHaveBeenCalled();
});

it('preserves uncancelled native POST until the framework itself handles it', () => {
  document.body.innerHTML = '<form method="post"><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>';
  const defaults: boolean[] = [];
  document.querySelector('form')!.addEventListener('submit', event => { defaults.push(event.defaultPrevented); event.preventDefault(); });
  expect(submitLoginForm(document.querySelector('input')!)).toBe(true);
  expect(defaults).toEqual([false]);
});

it.each(['form', 'root'])('preserves a %s SPA handler that respects earlier cancellation', location => {
  document.body.innerHTML = '<form><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>';
  const accepted = vi.fn(); const before: boolean[] = [];
  const owner = location === 'form' ? document.querySelector('form')! : document;
  const handler = (event: Event) => {
    before.push(event.defaultPrevented);
    if (event.defaultPrevented) return;
    event.preventDefault(); accepted();
  };
  owner.addEventListener('submit', handler);
  try {
    expect(submitLoginForm(document.querySelector('input')!)).toBe(true);
    expect(before).toEqual([false]); expect(accepted).toHaveBeenCalledTimes(1);
  } finally { owner.removeEventListener('submit', handler); }
});
