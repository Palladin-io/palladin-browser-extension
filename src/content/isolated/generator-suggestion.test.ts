// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';
import { PasswordCaptureController } from './capture';
import { startGeneratorSuggestion } from './generator-suggestion';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps the suggestion during a history write but cancels it when disabled', async () => {
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
    changes({ 'palladin.generator-history.v1:test': { newValue: { version: 1, ciphertext: 'synthetic' } } }, 'local');
    expect(surface!.isConnected).toBe(true);
    changes({ [GENERATOR_SUGGESTIONS_KEY]: { newValue: false } }, 'local');
    expect(surface!.isConnected).toBe(false);
  } finally { suggestion.stop(); }
});
