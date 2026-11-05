// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';
import { PasswordCaptureController } from './capture';
import { startGeneratorSuggestion } from './generator-suggestion';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps the suggestion during an unrelated storage write but cancels it when disabled', async () => {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: () => 'en' },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener, removeListener: vi.fn() } },
  });
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  const input = document.querySelector('input')!;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 240, 40));
  const capture = new PasswordCaptureController(document, () => 'https://example.test/signup', 'document_0123456789abcdef');
  capture.scan();
  const suggestion = startGeneratorSuggestion(document, 'document_0123456789abcdef', capture);
  try {
    await Promise.resolve();
    input.focus();
    const surface = document.querySelector('palladin-autofill');
    expect(surface).not.toBeNull();
    const changes = addListener.mock.calls[0]![0];
    changes({ 'unrelated-preference': { newValue: { version: 1, ciphertext: 'synthetic' } } }, 'local');
    expect(surface!.isConnected).toBe(true);
    changes({ [GENERATOR_SUGGESTIONS_KEY]: { newValue: false } }, 'local');
    expect(surface!.isConnected).toBe(false);
  } finally { suggestion.stop(); }
});

it('offers animated options without page text inputs and sends selected settings only on use', async () => {
  const closed = await import('./closed-surface');
  const original = closed.createClosedSurface;
  let root!: ShadowRoot;
  let trusted = false;
  const surfaceSpy = vi.spyOn(closed, 'createClosedSurface').mockImplementation((doc, name) => {
    const surface = original(doc, name); root = surface.shadow;
    return { ...surface, acceptsAction: () => trusted };
  });
  const sendMessage = vi.fn(async () => ({ accepted: true, status: 'filled' }));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage }, i18n: { getUILanguage: () => 'en' },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  const input = document.querySelector('input')!;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 240, 40));
  const capture = new PasswordCaptureController(document, () => 'https://example.test/signup', 'document_0123456789abcdef'); capture.scan();
  const suggestion = startGeneratorSuggestion(document, 'document_0123456789abcdef', capture);
  const button = (label: string) => [...root.querySelectorAll('button')].find(item => item.textContent === label)!;
  try {
    await Promise.resolve(); input.focus();
    expect(root.querySelector('input,textarea,select')).toBeNull();
    const options = button('Options'); expect(options).toBeDefined();
    expect(options.getAttribute('aria-expanded')).toBe('false'); options.click();
    expect(options.getAttribute('aria-expanded')).toBe('false');
    expect(sendMessage).not.toHaveBeenCalled();
    trusted = true; options.click();
    expect(options.getAttribute('aria-expanded')).toBe('true');
    button('Passphrase').click(); button('Dot').click();
    expect(sendMessage).not.toHaveBeenCalled();
    button('Use strong password').click();
    await Promise.resolve(); await Promise.resolve();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      options: { mode: 'passphrase', words: 6, separator: '.', capitalize: false, includeNumber: true },
    }));
  } finally { suggestion.stop(); surfaceSpy.mockRestore(); }
});
