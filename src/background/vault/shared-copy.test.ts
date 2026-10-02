import { describe, expect, it } from 'vitest';
import { sharedCopySecret } from './shared-copy';

const otp = 'otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=6';
const field = (id: string, type: 'text' | 'multiline' | 'concealed' | 'totp', value: string) =>
  ({ id, label: id.startsWith('custom:') ? 'Extra' : '', type, value });

describe('received Entry conversion', () => {
  it('preserves credential password, TOTP, notes, description and custom fields', () => {
    const secret = sharedCopySecret({ schema: 'palladin.entry-share.v1', title: 'Example', entryType: 'credential', fields: [
      field('credential.username', 'text', 'ada'), field('credential.password', 'concealed', 'synthetic-password'),
      field('credential.url', 'text', 'https://example.com'), field('credential.totp', 'totp', otp),
      field('notes', 'multiline', 'synthetic note'), field('description', 'multiline', 'synthetic description'),
      field('custom:original', 'concealed', 'synthetic custom'),
      field('custom:second', 'totp', otp),
    ] });
    expect(secret.entryType).toBe('credential');
    if (secret.entryType !== 'credential') throw new Error('wrong type');
    expect(secret.content).toMatchObject({ username: 'ada', password: 'synthetic-password',
      url: 'https://example.com', urlDomain: 'example.com', notes: 'synthetic note' });
    expect(secret.description).toBe('synthetic description');
    expect(secret.content.totp?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(secret.content.customFields).toHaveLength(2);
    expect(secret.content.customFields[0]?.value).toBe('synthetic custom');
    expect(secret.content.customFields[1]?.value).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' });
    expect(secret.discoverable).toBe(true);
  });

  it('rejects a key URL while the extension canonical writer lacks it', () => {
    expect(() => sharedCopySecret({ schema: 'palladin.entry-share.v1', title: 'API key', entryType: 'key', fields: [
      field('key.value', 'concealed', 'synthetic-key'), field('key.url', 'text', 'https://example.com'),
    ] })).toThrow('Invalid shared copy');
  });

  it('rejects malformed and duplicate fields without partial mutation', () => {
    const base = { schema: 'palladin.entry-share.v1', title: 'Example', entryType: 'credential' };
    expect(() => sharedCopySecret({ ...base, fields: [field('credential.password', 'text', 'unsafe')] })).toThrow();
    expect(() => sharedCopySecret({ ...base, fields: [field('credential.password', 'concealed', 'a'),
      field('credential.password', 'concealed', 'b')] })).toThrow();
    expect(() => sharedCopySecret({ ...base, fields: [field('credential.totp', 'totp', 'bad')] })).toThrow();
  });

  it('rejects missing native fields instead of creating a truncated Entry', () => {
    const common = { schema: 'palladin.entry-share.v1', title: 'Synthetic entry' };
    const cases = [
      { entryType: 'credential', fields: [field('credential.url', 'text', 'https://example.com')] },
      { entryType: 'key', fields: [field('notes', 'multiline', 'Only a note')] },
      { entryType: 'script', fields: [field('script.interpreter', 'text', 'bash')] },
      { entryType: 'creditCard', fields: [field('creditCard.cardNumber', 'concealed', '4111111111111111')] },
    ];
    for (const candidate of cases) expect(() => sharedCopySecret({ ...common, ...candidate })).toThrow('Invalid shared copy');
  });

  it('preserves legitimately empty native values when their fields are present', () => {
    const secret = sharedCopySecret({ schema: 'palladin.entry-share.v1', title: 'Empty login', entryType: 'credential', fields: [
      field('credential.username', 'text', ''), field('credential.password', 'concealed', ''),
    ] });
    expect(secret.entryType).toBe('credential');
    if (secret.entryType !== 'credential') throw new Error('wrong type');
    expect(secret.content.username).toBe('');
    expect(secret.content.password).toBe('');
  });

  it('preserves card CVV and never exposes it to agents', () => {
    const secret = sharedCopySecret({ schema: 'palladin.entry-share.v1', title: 'Card', entryType: 'creditCard', fields: [
      field('creditCard.cardholderName', 'text', 'Ada'), field('creditCard.cardNumber', 'concealed', '4111111111111111'),
      field('creditCard.cvv', 'concealed', '123'), field('creditCard.expiryMonth', 'text', '12'),
      field('creditCard.expiryYear', 'text', '2030'),
    ] });
    if (secret.entryType !== 'creditCard') throw new Error('wrong type');
    expect(secret.content.cvv).toBe('123');
    expect(secret.agentFieldAccess['creditCard.cvv']).toBe('never');
  });
});
