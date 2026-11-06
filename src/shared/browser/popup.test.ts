import { describe, expect, it, vi } from 'vitest';
import { openCapturePopup } from './popup';

describe('capture popup', () => {
  it.each(['chromium', 'firefox', 'safari'] as const)('opens the native popup on %s directly in the gesture', async target => {
    const openPopup = vi.fn(async () => undefined);
    const result = openCapturePopup(7, target, { chrome: { action: { openPopup } } });
    expect(openPopup).toHaveBeenCalledWith({ windowId: 7 });
    expect(await result).toBe(true);
  });
  it('uses the Firefox browser namespace when available', async () => {
    const openPopup = vi.fn(async () => undefined);
    expect(await openCapturePopup(7, 'firefox', { browser: { action: { openPopup } } })).toBe(true);
    expect(openPopup).toHaveBeenCalledWith({ windowId: 7 });
  });
  it('leaves manual toolbar opening available when unsupported or rejected', async () => {
    expect(await openCapturePopup(7, 'safari', {})).toBe(false);
    const openPopup = vi.fn(async () => { throw new Error('gesture unavailable'); });
    expect(await openCapturePopup(7, 'chromium', { chrome: { action: { openPopup } } })).toBe(false);
  });
});
