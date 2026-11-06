// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';
import { PasswordCaptureController } from './capture';
import { startGeneratorSuggestion } from './generator-suggestion';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps the suggestion during an unrelated storage write but cancels it when disabled', async () => {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ accepted: true, status: 'blocked' })) },
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

it('previews before use and sends only the displayed preview ID on a protected action', async () => {
  const closed = await import('./closed-surface');
  const original = closed.createClosedSurface;
  let root!: ShadowRoot;
  let trusted = false;
  const spy = vi.spyOn(closed, 'createClosedSurface').mockImplementation((doc, name) => {
    const surface = original(doc, name); root = surface.shadow;
    return { ...surface, acceptsAction: () => trusted };
  });
  const sendMessage = vi.fn(async (command) => command.type === 'preview'
    ? { status: 'preview', previewId: 'preview_0123456789abcdef', value: 'synthetic-preview-123', expiresAt: Date.now() + 60_000 }
    : command.type === 'use' ? { status: 'filled' } : { accepted: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, i18n: { getUILanguage: () => 'en' },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  document.body.innerHTML = '<form><input type="password" autocomplete="new-password"></form>';
  const input = document.querySelector('input')!;
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 320, 40));
  const capture = new PasswordCaptureController(document, () => 'https://example.test/signup', 'document_0123456789abcdef'); capture.scan();
  const suggestion = startGeneratorSuggestion(document, 'document_0123456789abcdef', capture);
  try {
    await Promise.resolve(); input.focus();
    await vi.waitFor(() => expect(root.querySelector('code')?.textContent).toBe('synthetic-preview-123'));
    expect(root.querySelector('input[type="text"],textarea')).toBeNull();
    expect(root.querySelector('input[type="range"]')).not.toBeNull();
    const use = [...root.querySelectorAll('button')].find(button => button.textContent === 'Use password')!;
    use.click(); expect(sendMessage.mock.calls.some(([command]) => command.type === 'use')).toBe(false);
    trusted = true;
    const click = (label: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
    const choose = (label: string, option: string) => {
      click(label);
      [...root.querySelectorAll<HTMLButtonElement>('[role=option]')].find(button => button.textContent === option)!.click();
    };
    click('Password options');
    click('Numbers');
    choose('Type', 'Passphrase');
    choose('Words', '6');
    choose('Separator', 'Dot');
    choose('Type', 'Password');
    expect(root.querySelector('[aria-label="Numbers"]')?.getAttribute('aria-checked')).toBe('false');
    choose('Type', 'Passphrase');
    expect(root.querySelector('[aria-label="Words"]')?.textContent).toBe('6');
    expect(root.querySelector('[aria-label="Separator"]')?.textContent).toBe('Dot');
    click('Words'); click('Separator');
    expect(root.querySelector('[role=listbox][aria-label="Words"]')?.hasAttribute('hidden')).toBe(true);
    root.querySelector('.generator-heading')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(root.querySelector('[role=listbox][aria-label="Separator"]')?.hasAttribute('hidden')).toBe(true);
    await vi.waitFor(() => expect(use.disabled).toBe(false));
    use.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'use', previewId: 'preview_0123456789abcdef' })));
    const command = sendMessage.mock.calls.find(([value]) => value.type === 'use')![0];
    expect(command).not.toHaveProperty('value');
    expect(root.querySelector('.generator-heading')?.textContent).toContain('Use strong password');
  } finally { suggestion.stop(); spy.mockRestore(); }
});
