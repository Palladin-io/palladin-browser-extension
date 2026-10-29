import { describe, expect, it, vi } from 'vitest';
import { dispatchSecretCapturePopup } from './secret-dispatch';
import { SECRET_CAPTURE_CHANNEL } from '@shared/messaging/secret-capture';
const save = { channel: SECRET_CAPTURE_CHANNEL, type: 'save', id: 'pending', vaultId: 'v', entry: { entryType: 'key', label: 'Key', value: 'synthetic-key' } };
describe('secret capture popup dispatcher', () => {
  it('rejects a valid save from any tab/page sender before the mutation handler', async () => {
    let mutations = 0; const handle = vi.fn(async () => { mutations++; return { status: 'saved' as const }; });
    for (const sender of [{ id: 'ext', url: 'https://page.test', tab: { id: 1 } }, { id: 'ext', url: 'chrome-extension://ext/popup.html', tab: { id: 1 } }, { id: 'foreign', url: 'chrome-extension://ext/popup.html' }]) {
      expect(dispatchSecretCapturePopup(save, sender, 'ext', 'chrome-extension://ext/', handle)).toBeNull();
    }
    expect(mutations).toBe(0);
    await expect(dispatchSecretCapturePopup(save, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'ext', 'chrome-extension://ext/', handle)).resolves.toEqual({ status: 'saved' });
    expect(mutations).toBe(1);
  });
  it('rejects malformed card edits at the existing Vault input boundary', () => {
    const result = dispatchSecretCapturePopup({ ...save, entry: { entryType: 'creditCard', label: 'Test', cardNumber: 4111 } }, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'ext', 'chrome-extension://ext/', async () => ({ status: 'saved' }));
    expect(result).toBeNull();
  });
});

it('allows explicit candidate selection only through a valid native extension sender', async () => {
  const command = { channel: SECRET_CAPTURE_CHANNEL, type: 'begin-review', id: 'pending' };
  const handle = vi.fn(async () => ({ status: 'empty' as const }));
  for (const sender of [{ id: 'ext', url: 'https://page.test', tab: { id: 1 } }, { id: 'ext', url: 'chrome-extension://ext/popup.html', tab: { id: 1 } }, { id: 'foreign', url: 'chrome-extension://ext/popup.html' }]) {
    expect(dispatchSecretCapturePopup(command, sender, 'ext', 'chrome-extension://ext/', handle)).toBeNull();
  }
  expect(dispatchSecretCapturePopup({ ...command, id: '' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'ext', 'chrome-extension://ext/', handle)).toBeNull();
  expect(handle).not.toHaveBeenCalled();
  await expect(dispatchSecretCapturePopup(command, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'ext', 'chrome-extension://ext/', handle)).resolves.toEqual({ status: 'empty' });
  expect(handle).toHaveBeenCalledWith(command);
});
