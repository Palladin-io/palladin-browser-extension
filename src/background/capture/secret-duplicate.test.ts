import { describe, expect, it } from 'vitest';
import { isExactCapturedSecret } from './secret-duplicate';
import type { MemberSecretV1 } from '@palladin/crypto';
const card = { entryType: 'creditCard', label: 'Card', cardNumber: '4111 1111 1111 1111', cardholderName: 'Synthetic Holder', expiryMonth: '08', expiryYear: '2030' } as const;
const previous = { entryType: 'creditCard', content: { cardNumber: '4111111111111111', cardholderName: 'Synthetic Holder', expiryMonth: '08', expiryYear: '2030' } } as MemberSecretV1;
describe('local capture duplicate comparison', () => {
  it('matches exact card material but never treats changed expiry/CVV as an update', () => {
    expect(isExactCapturedSecret(card, previous)).toBe(true);
    expect(isExactCapturedSecret({ ...card, expiryYear: '2031' }, previous)).toBe(false);
    expect(isExactCapturedSecret({ ...card, cvv: '123' }, previous)).toBe(false);
  });
  it('preserves key bytes and does not deduplicate unrelated types', () => {
    const key = { entryType: 'key', label: 'Key', value: 'synthetic-key' } as const;
    expect(isExactCapturedSecret(key, { entryType: 'key', content: { value: 'synthetic-key' } } as MemberSecretV1)).toBe(true);
    expect(isExactCapturedSecret(key, { entryType: 'key', content: { value: ' synthetic-key' } } as MemberSecretV1)).toBe(false);
    expect(isExactCapturedSecret(key, previous)).toBe(false);
  });
});
