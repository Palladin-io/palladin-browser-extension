import { isManualEntrySaveInput } from '../vault/commands';
import { describe, expect, it } from 'vitest';
import { SecretCaptureFrames } from './secret-source';
import { isSecretCaptureContentCommand, isSecretCapturePopupCommand } from '@shared/messaging/secret-capture';
const sender = { id: 'extension', tab: { id: 1, url: 'https://shop.test/' }, frameId: 3, documentId: 'frame', url: 'https://processor.test/pay', origin: 'https://processor.test', documentLifecycle: 'active' } as chrome.runtime.MessageSender;
describe('capture browser authority', () => {
  it('accepts a registered HTTPS cross-origin frame, never sender claim without a live port', () => {
    const frames = new SecretCaptureFrames(() => 'top');
    expect(frames.source(sender, 'extension', 'local')).toBeNull();
    const stop = frames.register(sender, 'extension');
    expect(frames.source(sender, 'extension', 'local')).toMatchObject({ frameId: 3, browserDocumentId: 'frame', topDocumentId: 'top', url: 'https://processor.test/pay' });
    stop?.(); expect(frames.source(sender, 'extension', 'local')).toBeNull();
  });
  it('rejects inactive, foreign extension, HTTP, origin mismatch and stale parent documents', () => {
    let top = 'top'; const frames = new SecretCaptureFrames(() => top); frames.register(sender, 'extension');
    for (const patch of [{ id: 'foreign' }, { url: 'http://processor.test/pay' }, { documentLifecycle: 'cached' }, { origin: 'https://evil.test' }, { documentId: 'other' }]) {
      expect(frames.source({ ...sender, ...patch } as chrome.runtime.MessageSender, 'extension', 'local')).toBeNull();
    }
    top = 'new'; expect(frames.source(sender, 'extension', 'local')).toBeNull();
  });
  it('keeps popup save separate from observation and rejects extra untrusted fields', () => {
    const observe = { channel: 'palladin.secret-capture.v1', type: 'observe', documentId: 'local', candidate: { kind: 'key', value: 'synthetic-value' } };
    expect(isSecretCaptureContentCommand(observe)).toBe(true);
    expect(isSecretCaptureContentCommand({ ...observe, origin: 'https://spoof.test' })).toBe(false);
    expect(isSecretCapturePopupCommand(observe, isManualEntrySaveInput)).toBe(false);
    expect(isSecretCaptureContentCommand({ channel: observe.channel, type: 'begin-review', id: 'candidate', documentId: 'local' })).toBe(false);
    const save = { channel: observe.channel, type: 'save', id: 'candidate', vaultId: 'vault', entry: { entryType: 'key', label: 'Test', value: 'synthetic-value' } };
    expect(isSecretCapturePopupCommand(save, isManualEntrySaveInput)).toBe(true); expect(isSecretCaptureContentCommand(save)).toBe(false);
    expect(isSecretCapturePopupCommand({ ...save, entry: { ...save.entry, value: {} } }, isManualEntrySaveInput)).toBe(false);
  });
});

it('requires bounded isolated card-scope identity and does not accept it for keys', () => {
  const candidate = { kind: 'card', cardNumber: '4111111111111111', cardholderName: '', expiryMonth: '', expiryYear: '' };
  const observation = { channel: 'palladin.secret-capture.v1', type: 'observe', documentId: 'local', candidate };
  expect(isSecretCaptureContentCommand(observation)).toBe(false);
  expect(isSecretCaptureContentCommand({ ...observation, candidate: { ...candidate, scopeId: 'a'.repeat(32) } })).toBe(true);
  for (const scopeId of ['', 'a'.repeat(33), '<form>', 1]) {
    expect(isSecretCaptureContentCommand({ ...observation, candidate: { ...candidate, scopeId } })).toBe(false);
  }
  expect(isSecretCaptureContentCommand({ ...observation, candidate: { kind: 'key', value: 'synthetic-api-value', scopeId: 'a'.repeat(32) } })).toBe(false);
});
