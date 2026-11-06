import { isManualEntrySaveInput } from '../../background/vault/commands';
import { describe, expect, it } from 'vitest';
import { isNativeLoginCaptureCommand as validate, NATIVE_LOGIN_CAPTURE_CHANNEL } from './native-login-capture';
const isNativeLoginCaptureCommand = (value: unknown) => validate(value, isManualEntrySaveInput);
const channel = NATIVE_LOGIN_CAPTURE_CHANNEL;
describe('native login capture input boundary', () => {
  it('accepts a bounded complete credential and rejects page-supplied target coordinates', () => {
    const value = { channel, type: 'save', promptId: 'prompt', targetId: 'target', autoUpdate: false,
      entry: { entryType: 'credential', label: 'Example', username: 'alice', password: 'secret', url: 'https://example.com',
        customFields: [{ id: 'custom:extra1234', label: 'Extra', type: 'concealed', value: 'value' }] } };
    expect(isNativeLoginCaptureCommand(value)).toBe(true);
    expect(isNativeLoginCaptureCommand({ ...value, vaultId: 'forged' })).toBe(false);
    expect(isNativeLoginCaptureCommand({ ...value, entry: { ...value.entry, password: '' } })).toBe(false);
    expect(isNativeLoginCaptureCommand({ ...value, entry: { ...value.entry, customFields: [{ id: 'credential.password', label: 'x', type: 'text', value: 'x' }] } })).toBe(false);
  });
  it('never accepts a page URL or document binding from the native client', () => {
    expect(isNativeLoginCaptureCommand({ channel, type: 'get' })).toBe(true);
    expect(isNativeLoginCaptureCommand({ channel, type: 'get', url: 'https://evil.example' })).toBe(false);
    expect(isNativeLoginCaptureCommand({ channel, type: 'get', documentId: 'forged' })).toBe(false);
  });
});
