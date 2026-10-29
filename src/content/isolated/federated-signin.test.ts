// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { within } from '@testing-library/dom';
import {
  isFederatedSignInCommand,
  isFederatedSignInResult,
  type SignInPrompt,
  type SignInSuggestion,
} from '@shared/messaging/federated-signin';
import { detectProviderControls, providerForControl, uniqueProviderControl } from './federated-signin-detect';
import { FederatedSignInSurface, startFederatedSignIn } from './federated-signin';

const acceptsAction = vi.hoisted(() => vi.fn());
vi.mock('./closed-surface', async (importOriginal) => {
  const original = await importOriginal<typeof import('./closed-surface')>();
  return { createClosedSurface: (...args: Parameters<typeof original.createClosedSurface>) =>
    ({ ...original.createClosedSurface(...args), acceptsAction }) };
});

const DOCUMENT = 'document-123456789';

describe('provider control detection', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it.each([
    ['<button>Continue with Google</button>', 'google'],
    ['<button>Zaloguj się przez Apple</button>', 'apple'],
    ['<a href="/auth/microsoft">Sign in with Microsoft</a>', 'microsoft'],
    ['<button aria-label="GitHub"><svg></svg></button>', 'github'],
    ['<div role="button"><img alt="Facebook"> Log in with Facebook</div>', 'facebook'],
    ['<a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=x">Next</a>', 'google'],
  ])('recognizes %s', (html, provider) => {
    document.body.innerHTML = html;
    expect(providerForControl(document.body.firstElementChild!)).toBe(provider);
  });

  it.each([
    '<button>Google Pixel 9 review</button>',
    '<button>Apple and Google compared</button>',
    '<a href="https://accounts-google.example.net/o/oauth2/v2/auth">Continue</a>',
    '<button>Sign in</button>',
    `<button>${'Continue with Google '.repeat(10)}</button>`,
  ])('ignores %s', (html) => {
    document.body.innerHTML = html;
    expect(providerForControl(document.body.firstElementChild!)).toBeNull();
  });

  it('skips hidden, disabled, opted-out and Palladin-owned controls and reports ambiguity', () => {
    document.body.innerHTML = `
      <button id="a">Continue with Google</button>
      <button id="b" disabled>Continue with Apple</button>
      <div data-palladin-ignore="true"><button>Continue with GitHub</button></div>
      <button id="hidden">Continue with Facebook</button>
      <button id="c">Sign up with Google</button>`;
    const visible = (element: HTMLElement) => element.id !== 'hidden';
    const controls = detectProviderControls(document, visible, () => false);
    expect(controls.map((control) => control.element.id)).toEqual(['a', 'c']);
    expect(uniqueProviderControl(controls, 'google')).toBeNull();
    expect(uniqueProviderControl(controls, 'apple')).toBeNull();
    const owned = detectProviderControls(document, visible, (element) => element.id === 'a');
    expect(uniqueProviderControl(owned, 'google')?.id).toBe('c');
  });
});

describe('federated sign-in message guards', () => {
  const base = { channel: 'palladin.federated-signin', documentId: DOCUMENT };
  it('accepts exact commands and rejects extra, forged or malformed fields', () => {
    expect(isFederatedSignInCommand({ ...base, type: 'intent', provider: 'google' })).toBe(true);
    expect(isFederatedSignInCommand({ ...base, type: 'intent', provider: 'myspace' })).toBe(false);
    expect(isFederatedSignInCommand({ ...base, type: 'intent', provider: 'google', account: 'a@b.c' })).toBe(false);
    expect(isFederatedSignInCommand({ ...base, type: 'confirm', promptId: 'prompt-1234567890', accountId: 'account-1234567890',
      targetId: 'target-1234567890', locale: 'en' })).toBe(true);
    expect(isFederatedSignInCommand({ ...base, type: 'confirm', promptId: 'prompt-1234567890', accountId: 'alice@example.com',
      targetId: 'target-1234567890', locale: 'en' })).toBe(false);
    expect(isFederatedSignInCommand({ ...base, type: 'confirm', promptId: 'prompt-1234567890', accountId: 'account-1234567890',
      targetId: 'target-1234567890', locale: 'de' })).toBe(false);
    expect(isFederatedSignInCommand({ ...base, documentId: 'short', type: 'get' })).toBe(false);
    expect(isFederatedSignInCommand({ ...base, channel: 'other', type: 'get' })).toBe(false);
  });

  it('rejects a ready-looking locked prompt and unknown defaults', () => {
    const prompt = { id: 'prompt-1234567890', site: 'example.com', provider: 'google', state: 'locked',
      accounts: [{ id: 'account-1234567890', label: 'a@b.c', source: 'vault' }], targets: [],
      defaultAccountId: null, defaultTargetId: null };
    expect(isFederatedSignInResult({ status: 'prompt', prompt })).toBe(false);
    expect(isFederatedSignInResult({ status: 'prompt', prompt: { ...prompt, state: 'ready', defaultAccountId: 'missing-123456789' } })).toBe(false);
    expect(isFederatedSignInResult({ status: 'prompt', prompt: { ...prompt, state: 'ready' } })).toBe(true);
  });
});

const prompt: SignInPrompt = {
  id: 'prompt-1234567890', site: 'app.example.com', provider: 'google', state: 'ready',
  accounts: [
    { id: 'account-work-123456', label: 'work@corp.com', source: 'used' },
    { id: 'account-home-123456', label: 'alice@gmail.com', source: 'vault' },
    { id: 'account-none-123456', label: '', source: 'none' },
  ],
  targets: [
    { id: 'target-update-12345', action: 'update', label: 'Example (alice)', vaultLabel: 'Personal', current: null },
    { id: 'target-create-12345', action: 'create', label: 'app.example.com', vaultLabel: 'Personal', current: null },
  ],
  defaultAccountId: null, defaultTargetId: null,
};

describe('federated sign-in surface', () => {
  let shadow: ShadowRoot;
  let surface: FederatedSignInSurface;
  const send = vi.fn();
  const onChoose = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset().mockResolvedValue({ status: 'saved', action: 'updated' });
    onChoose.mockReset().mockReturnValue('opened');
    acceptsAction.mockReset().mockReturnValue(true);
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) {
      shadow = attach.call(this, options);
      return shadow;
    });
    surface = new FederatedSignInSurface(document, DOCUMENT, send, onChoose);
  });
  afterEach(() => { surface.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const ui = () => within(shadow as unknown as HTMLElement);

  it('requires an explicit account and target before remembering and has no text inputs', async () => {
    surface.showResult({ status: 'prompt', prompt });
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector('palladin-capture')!.shadowRoot).toBeNull();
    expect(shadow.querySelector('input, textarea, select')).toBeNull();
    expect(ui().queryByRole('button', { name: /^Remember for/ })).toBeNull();
    ui().getByRole('radio', { name: /work@corp\.com/ }).click();
    expect(ui().queryByRole('button', { name: /^Remember for/ })).toBeNull();
    ui().getByRole('radio', { name: /Example \(alice\)/ }).click();
    ui().getByRole('button', { name: 'Remember for Example (alice)' }).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledExactlyOnceWith({ channel: 'palladin.federated-signin', documentId: DOCUMENT,
      type: 'confirm', promptId: prompt.id, accountId: 'account-work-123456', targetId: 'target-update-12345', locale: 'en' });
    expect(ui().getByRole('status')).toHaveTextContent('Sign-in method remembered');
  });

  it('ignores untrusted or overlaid clicks', async () => {
    surface.showResult({ status: 'prompt', prompt: { ...prompt, defaultAccountId: 'account-work-123456', defaultTargetId: 'target-create-12345' } });
    ui().getByRole('button', { name: 'Remember for New sign-in for app.example.com' }).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send, 'A click right after the surface appears is ignored').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    acceptsAction.mockReturnValue(false);
    ui().getByRole('button', { name: 'Remember for New sign-in for app.example.com' }).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows a locked state with only Unlock and Not now', () => {
    surface.showResult({ status: 'prompt', prompt: { ...prompt, state: 'locked', accounts: [], targets: [] } });
    expect(ui().getByRole('button', { name: 'Unlock Palladin' })).toBeVisible();
    expect(ui().queryAllByRole('radio')).toHaveLength(0);
  });

  it('localizes the prompt', () => {
    surface.setAppearance('pl', 'dark');
    surface.showResult({ status: 'prompt', prompt });
    expect(ui().getByRole('radiogroup', { name: 'Którego konta Google użyto?' })).toBeVisible();
    expect(ui().getByRole('radio', { name: 'Konto nieokreślone' })).toBeVisible();
  });

  it('opens only after an explicit suggestion choice and reports the manual fallback', async () => {
    const suggestions: SignInSuggestion[] = [
      { id: 'suggestion-1234567890', provider: 'google', account: 'work@corp.com', label: 'Work', vaultLabel: 'Team' },
      { id: 'suggestion-0987654321', provider: 'google', account: 'alice@gmail.com', label: 'Home', vaultLabel: 'Personal' },
    ];
    surface.showSuggestions(suggestions);
    await vi.advanceTimersByTimeAsync(600);
    expect(onChoose).not.toHaveBeenCalled();
    ui().getByRole('button', { name: /alice@gmail\.com/ }).click();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(suggestions[1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({ channel: 'palladin.federated-signin', documentId: DOCUMENT,
      type: 'choose', suggestionId: 'suggestion-0987654321' });
    expect(ui().getByRole('status')).toHaveTextContent('Opening Google');

    onChoose.mockReturnValue('manual');
    surface.showSuggestions(suggestions);
    await vi.advanceTimersByTimeAsync(600);
    ui().getByRole('button', { name: /work@corp\.com/ }).click();
    expect(ui().getByRole('status')).toHaveTextContent('Use the Google button on this page.');
  });
  it('clears remembered-account suggestions on lock so they cannot be clicked', async () => {
    surface.showSuggestions([{ id: 'suggestion-1234567890', provider: 'google', account: 'work@corp.com', label: 'Work', vaultLabel: 'Team' }]);
    await vi.advanceTimersByTimeAsync(600);
    surface.clearSuggestions();
    expect(document.querySelector('palladin-capture')).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('keeps a confirmation prompt when suggestions are cleared and shows Credential context', async () => {
    surface.showResult({ status: 'prompt', prompt: { ...prompt, accounts: [
      { id: 'account-ctx-1234567', label: 'shared@corp.com', source: 'vault', context: 'Team Google \u00b7 Team' },
      ...prompt.accounts] } });
    surface.clearSuggestions();
    expect(ui().getByRole('radio', { name: /shared@corp\.com.*Team Google · Team/ })).toBeVisible();
  });
});

describe('federated sign-in controller', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });

  it('retries suggestions for provider controls rendered after the first attempt', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'suggest'
      ? { status: 'suggestions', suggestions: [] } : { status: 'prompt', prompt: null });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() }, local: { get: vi.fn(async () => ({})) } },
      i18n: { getUILanguage: () => 'en' },
    });
    const hit = () => document.querySelector('button');
    Object.assign(document, { elementFromPoint: hit, elementsFromPoint: () => [hit()].filter(Boolean) });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 10, top: 10, width: 120, height: 32, right: 130, bottom: 42, x: 10, y: 10, toJSON: () => ({}) } as DOMRect);
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
    document.body.innerHTML = '';
    const controller = startFederatedSignIn(document, DOCUMENT, () => false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'suggest' }));
    document.body.innerHTML = '<button>Continue with Google</button>';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'suggest' }));
    controller.stop();
  });
});
