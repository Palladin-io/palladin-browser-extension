// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveLogin } from './agent-live-login';
import { AGENT_INJECT_STEP_CHANNEL } from '@shared/messaging';
import { formContainsAgentManagedControl } from './agent-managed-controls';
const documentId = 'd'.repeat(32);
const url = 'https://signin.aws.amazon.com/signin';
const dom = { isVisible: (element: HTMLElement) => !element.hidden && !element.closest('[hidden]') };
let live: LiveLogin | undefined;
afterEach(() => { live?.clear(); document.body.innerHTML = ''; });
function setup(html: string) {
  document.body.innerHTML = html;
  live = new LiveLogin(document, documentId, () => url, () => true, dom);
  return live;
}
it('discovers the observed AWS Root identifier and Next without copying its page selectors', () => {
  const instance = setup(readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-18/page.html', 'utf8'));
  const form = instance.inspect(url);
  expect(form?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username']);
  expect(JSON.stringify(form)).not.toContain('resolving_input');
  const submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submit);
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com',
    step: form!.steps[0]!, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }] })).toEqual({ ok: true });
  expect(document.querySelector<HTMLInputElement>('#resolving_input')!.value).toBe('synthetic@example.test');
  expect(submit).toHaveBeenCalledTimes(1);
});
it.each(['', 'synthetic@example.test'])('inspects observed AWS Root with a prefilled identity without reading its value (%s)', (value) => {
  const instance = setup(readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-18/page.html', 'utf8'));
  const input = document.querySelector<HTMLInputElement>('#resolving_input')!;
  input.value = value;
  Object.defineProperty(input, 'value', { get() { throw new Error('Live discovery must remain value-free'); } });
  expect(instance.inspect(url)?.steps[0]?.fields.map(field => field.entryFieldId)).toEqual(['credential.username']);
});
it('binds the actual controls and rejects replacement before any write', () => {
  const instance = setup('<form><input autocomplete="username"><input type="password"><button>Sign in</button></form>');
  const form = instance.inspect(url)!;
  document.querySelector('input')!.outerHTML = '<input autocomplete="username">';
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com',
    step: form.steps[0]!, values: [{ entryFieldId: 'credential.username', value: 'synthetic' }, { entryFieldId: 'credential.password', value: 'synthetic-password' }] }).ok).toBe(false);
  expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('');
});
it('discovers authenticator MFA but rejects explicit SMS, signup and ambiguous forms', () => {
  let instance = setup('<form><label>Authenticator code<input autocomplete="one-time-code"></label><button>Verify</button></form>');
  expect(instance.inspect(url)?.steps[0]?.fields[0]?.entryFieldId).toBe('credential.totp');
  instance.clear();
  for (const html of [
    '<form>Code sent by SMS<input autocomplete="one-time-code"><button>Verify</button></form>',
    '<form><input autocomplete="username"><input type="password" autocomplete="new-password"><button>Register</button></form>',
    '<form><input type="email"><button>Next</button></form><form><input type="email"><button>Next</button></form>',
  ]) { instance = setup(html); expect(instance.inspect(url)).toBeNull(); instance.clear(); }
});

// The HTML is observed AWS markup; these event handlers are synthetic mechanism
// regressions, not a recording of AWS's production JavaScript.
it.each(['value attribute', 'unrelated DOM'])('keeps live bindings across %s updates from input handling', (mutation) => {
  const instance = setup(readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-18/page.html', 'utf8'));
  const form = instance.inspect(url)!;
  const input = document.querySelector<HTMLInputElement>('#resolving_input')!;
  input.addEventListener('input', () => {
    if (mutation === 'value attribute') input.setAttribute('value', input.value);
    else document.body.append(document.createElement('aside'));
  });
  const submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submit);
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com',
    step: form.steps[0]!, values: [{ entryFieldId: 'credential.username', value: 'synthetic@example.test' }] })).toEqual({ ok: true });
  expect(submit).toHaveBeenCalledTimes(1);
});

it.each(['replacement', 'field type', 'new field', 'submit destination', 'submit caption', 'covered submit'])('rejects %s during input handling without submitting', (mutation) => {
  const instance = setup('<form><label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button></form>');
  const form = instance.inspect(url)!;
  const input = document.querySelector<HTMLInputElement>('input')!;
  const action = document.querySelector('button')!;
  input.addEventListener('input', () => {
    if (mutation === 'replacement') action.replaceWith(action.cloneNode(true));
    if (mutation === 'field type') input.type = 'text';
    if (mutation === 'new field') input.after(document.createElement('input'));
    if (mutation === 'submit destination') action.setAttribute('formaction', '/different-action');
    if (mutation === 'submit caption') action.textContent = 'Delete account';
    if (mutation === 'covered submit') action.hidden = true;
  });
  const submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('form')!.addEventListener('submit', submit);
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com',
    step: form.steps[0]!, values: [{ entryFieldId: 'credential.password', value: 'synthetic-password' }] }).ok).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('does not extend expiry when revalidating live controls', () => {
  vi.useFakeTimers();
  try {
    const instance = setup('<form><label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button></form>');
    const form = instance.inspect(url)!;
    vi.advanceTimersByTime(60_000);
    expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com',
      step: form.steps[0]!, values: [{ entryFieldId: 'credential.password', value: 'synthetic-password' }] }).ok).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
  } finally { vi.useRealTimers(); }
});
it('reports supported AWS, CAPTCHA-only, SMS and absent controls without authentication claims', () => {
  const instance = setup(readFileSync('tests/fixtures/forms/aws-root-identifier-2026-09-18/page.html', 'utf8'));
  expect(instance.probe(url).outcome).toBe('ready');
  document.body.innerHTML = '<div data-sitekey="synthetic">Security check</div>';
  expect(instance.probe(url)).toEqual({ outcome: 'challenge' });
  document.body.innerHTML = '<form>Code sent by SMS<input autocomplete="one-time-code"><button>Verify</button></form>';
  expect(instance.probe(url)).toEqual({ outcome: 'challenge' });
  document.body.innerHTML = '<p>Neutral destination with no supported login controls</p>';
  expect(instance.probe(url)).toEqual({ outcome: 'no-form' });
});
it.each(['matching', 'empty', 'foreign', 'changed during password input'])('preserves a carried-forward %s username and binds submit to approved identity', state => {
  const instance = setup('<form><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>');
  const identity = document.querySelector<HTMLInputElement>('input')!;
  const password = document.querySelector<HTMLInputElement>('input[type=password]')!;
  identity.value = state === 'empty' ? '' : state === 'foreign' ? 'other@example.test' : 'approved@example.test';
  const events = vi.fn(); identity.addEventListener('input', events); identity.addEventListener('change', events);
  if (state === 'changed during password input') password.addEventListener('input', () => { identity.value = 'other@example.test'; });
  const submit = vi.fn((event: Event) => event.preventDefault()); document.querySelector('form')!.addEventListener('submit', submit);
  const plan = instance.inspect(url)!;
  const outcome = instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com', step: plan.steps[0]!,
    requireExistingUsername: true,
    values: [{ entryFieldId: 'credential.username', value: 'approved@example.test' }, { entryFieldId: 'credential.password', value: 'synthetic-password' }] });
  expect(outcome.ok).toBe(state === 'matching');
  expect(events).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledTimes(state === 'matching' ? 1 : 0);
  if (state !== 'matching') {
    expect(password.value).toBe('');
    expect(formContainsAgentManagedControl(document.querySelector('form')!)).toBe(false);
  }
});
it.each(['cross-origin action', 'foreign target', 'action changed during input'])('binds an open shadow login to its composed owner: %s', state => {
  const instance = setup('<form><div id="host"></div></form>');
  const owner = document.querySelector('form')!;
  const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input type="password" autocomplete="current-password"><button type="submit">Sign in</button>';
  if (state === 'cross-origin action') owner.action = 'https://foreign.example.test/';
  if (state === 'foreign target') owner.target = '_blank';
  const input = shadow.querySelector('input')!;
  if (state === 'action changed during input') input.addEventListener('input', () => { owner.action = 'https://foreign.example.test/'; });
  const clicked = vi.fn(); shadow.querySelector('button')!.addEventListener('click', clicked);
  const plan = instance.inspect(url)!;
  expect(plan).not.toBeNull();
  expect(instance.fill({ channel: AGENT_INJECT_STEP_CHANNEL, documentId, expectedDomain: 'signin.aws.amazon.com', step: plan.steps[0]!,
    values: [{ entryFieldId: 'credential.password', value: 'synthetic-password' }] }).ok).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});
