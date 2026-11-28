// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { describeProviderScreen, observeProviderAccount } from './provider-account';
import { isFederatedSignInCommand } from '@shared/messaging/federated-signin';

// Reduced from the public signed-out accounts.google.com/v3/signin/identifier DOM observed 2026-11-25
// in Chromium; only control attributes are kept, layout and scripts are omitted.
const IDENTIFIER = `<form><input jsname="Ufn6O" type="text" name="identifier" id="identifierId" autocomplete="username">
  <input type="password" name="hiddenPassword"><button name="action" jsname="Njthtb" id="identifierNext">Next</button></form>`;
const URL = 'https://accounts.google.com/v3/signin/identifier?client_id=x';
function setup(url = URL) {
  document.body.innerHTML = IDENTIFIER;
  const send = vi.fn();
  // jsdom cannot create trusted events; the trust predicate itself is asserted separately.
  const stop = observeProviderAccount(document, () => url, send, () => true);
  const input = document.querySelector<HTMLInputElement>('#identifierId')!;
  return { send, stop, input, next: () => document.querySelector<HTMLElement>('#identifierNext')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) };
}
beforeEach(() => { document.body.innerHTML = ''; });
// jsdom does not implement the submission that follows a button click.
document.addEventListener('click', event => event.preventDefault());

it('reports the submitted identifier only on submission', () => {
  const h = setup();
  h.input.value = ' Alice@Example.com ';
  h.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(h.send).not.toHaveBeenCalled();
  h.next();
  expect(h.send).toHaveBeenCalledExactlyOnceWith('Alice@Example.com');
  h.stop();
});
it('reports Enter in the identifier field but not other keys', () => {
  const h = setup();
  h.input.value = 'alice@example.com';
  h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  expect(h.send).not.toHaveBeenCalled();
  h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(h.send).toHaveBeenCalledOnce();
  h.stop();
});
it.each(['', '600100200', 'alice', 'a b@example.com'])('ignores a non-email identifier %s', value => {
  const h = setup(); h.input.value = value; h.next();
  expect(h.send).not.toHaveBeenCalled(); h.stop();
});
it.each(['https://accounts.google.com.evil.test/', 'http://accounts.google.com/', 'https://accounts.google.com:8443/', 'https://github.com/login'])('observes nothing on %s', url => {
  const h = setup(url); h.input.value = 'alice@example.com'; h.next();
  expect(h.send).not.toHaveBeenCalled(); h.stop();
});
it('ignores page-synthesized events and never reads a password', () => {
  document.body.innerHTML = IDENTIFIER;
  const send = vi.fn(); const stop = observeProviderAccount(document, () => URL, send);
  document.querySelector<HTMLInputElement>('#identifierId')!.value = 'alice@example.com';
  document.querySelector<HTMLElement>('#identifierNext')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(send).not.toHaveBeenCalled(); stop();
  const h = setup(); h.input.type = 'password'; h.input.value = 'alice@example.com'; h.next();
  expect(h.send).not.toHaveBeenCalled(); h.stop();
});
it('validates the account command', () => {
  const base = { channel: 'palladin.federated-signin', documentId: 'document-123456789', type: 'account' };
  expect(isFederatedSignInCommand({ ...base, account: 'alice@example.com' })).toBe(true);
  for (const account of ['', 'alice', 'a b@example.com', 'a\n@example.com', `${'a'.repeat(250)}@example.com`, 5]) expect(isFederatedSignInCommand({ ...base, account })).toBe(false);
  expect(isFederatedSignInCommand({ ...base, account: 'alice@example.com', provider: 'google' })).toBe(false);
});

it.each([
  ['account chooser', '<ul><li><div data-identifier="ada@example.org" role="link">Ada</div></li></ul>', { kind: 'account-chooser', emailAttribute: true, emailText: false }],
  ['identifier', '<input type="email" name="loginfmt">', { kind: 'identifier', identifierField: true }],
  ['password', '<input type="email" name="loginfmt"><input type="password" name="passwd">', { kind: 'password', passwordField: true }],
  ['consent', '<p>Continue as ada@example.org</p><button>Continue</button>', { kind: 'consent', emailText: true }],
  ['unknown', '<button>Allow</button>', { kind: 'unknown', identifierField: false, passwordField: false, emailAttribute: false, emailText: false }],
])('describes a %s screen with value-free flags only', (_name, html, expected) => {
  document.body.innerHTML = html;
  const rects = vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => document.body.textContent ?? '' });
  try {
    const screen = describeProviderScreen(document);
    expect(screen).toMatchObject(expected);
    expect(JSON.stringify(screen)).not.toMatch(/ada|example|loginfmt/);
    expect(isFederatedSignInCommand({ channel: 'palladin.federated-signin', documentId: 'a'.repeat(32), type: 'screen', screen })).toBe(true);
  } finally { rects.mockRestore(); delete (document.body as { innerText?: string }).innerText; }
});
it('rejects screen messages with extra keys, text or unknown kinds', () => {
  const base = { channel: 'palladin.federated-signin', documentId: 'a'.repeat(32), type: 'screen' };
  const screen = { kind: 'consent', identifierField: false, passwordField: false, emailAttribute: false, emailText: true };
  expect(isFederatedSignInCommand({ ...base, screen })).toBe(true);
  expect(isFederatedSignInCommand({ ...base, screen: { ...screen, email: 'ada@example.org' } })).toBe(false);
  expect(isFederatedSignInCommand({ ...base, screen: { ...screen, kind: 'ada@example.org' } })).toBe(false);
  expect(isFederatedSignInCommand({ ...base, screen: { ...screen, emailText: 'yes' } })).toBe(false);
});
