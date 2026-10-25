// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isFillable, isCurrentLoginTarget, loginTargetFor } from './credential-form-analysis';
import { startInlineAutofill } from './inline-autofill';

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { local: { get: vi.fn(async () => ({})) } }, i18n: { getUILanguage: () => 'en' } });
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

// Contract fixture, not a capture of authenticated user data. A real login pair
// deliberately proves that an explicit management-surface opt-out takes priority.
function renderLogin() {
  document.body.innerHTML = '<div id="scope"><form><label for="username">Username</label><input id="username" autocomplete="username"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"><button>Sign in</button></form></div>';
  return { scope: document.querySelector('#scope')!, username: document.querySelector<HTMLInputElement>('#username')!, password: document.querySelector<HTMLInputElement>('#password')! };
}

it('excludes a marked management surface while preserving ordinary login discovery', () => {
  const { scope, username, password } = renderLogin();
  const target = loginTargetFor(username);
  expect(target).not.toBeNull();
  scope.setAttribute('data-palladin-ignore', 'true');
  expect(loginTargetFor(username)).toBeNull();
  expect(isFillable(password)).toBe(false);
  expect(isCurrentLoginTarget(target!)).toBe(false);
  scope.removeAttribute('data-palladin-ignore');
  expect(loginTargetFor(username)).not.toBeNull();
});

it('honors opt-out on the field and across an open shadow root', () => {
  const { scope, username } = renderLogin();
  username.setAttribute('data-palladin-ignore', 'true');
  expect(isFillable(username)).toBe(false);
  const host = document.createElement('div');
  scope.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<input type="password">';
  scope.setAttribute('data-palladin-ignore', 'true');
  expect(isFillable(root.querySelector('input')!)).toBe(false);
});

it('removes an existing launcher when its ancestor opts out and rediscovers it after removal', async () => {
  const { scope } = renderLogin();
  const send = vi.fn(async () => ({ ok: true, kind: 'suggestions', status: 'locked', entries: [] }));
  const controller = startInlineAutofill(document, 'a'.repeat(32), send);
  try {
    await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1));
    scope.setAttribute('data-palladin-ignore', 'true');
    await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(0));
    scope.removeAttribute('data-palladin-ignore');
    await vi.waitFor(() => expect(document.querySelectorAll('palladin-autofill')).toHaveLength(1));
  } finally { controller.stop(); }
});
