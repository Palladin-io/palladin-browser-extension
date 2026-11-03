import { expect, it } from 'vitest';
import { TOTP_CAPTURE_CHANNEL as channel, isTotpContentCommand, isTotpPopupCommand } from './totp-capture';
it('separates content observations from native save commands and bounds payloads', () => {
  expect(isTotpContentCommand({ channel, type: 'observe', documentId: 'abcdefghijklmnop', uri: 'otpauth://totp/x?secret=AAAA', sequence: 1 })).toBe(true);
  expect(isTotpContentCommand({ channel, type: 'save', documentId: 'abcdefghijklmnop', id: 'a' })).toBe(false);
  expect(isTotpContentCommand({ channel, type: 'observe', documentId: 'abcdefghijklmnop', uri: 'x'.repeat(2049), sequence: 1 })).toBe(false);
  expect(isTotpPopupCommand({ channel, type: 'save', id: 'a', targetId: 'b', replace: false })).toBe(true);
  expect(isTotpPopupCommand({ channel, type: 'observe', uri: 'x' })).toBe(false);
});
it('accepts only a bounded worker verification request', async () => {
  const { isTotpVerificationRequest } = await import('./totp-capture');
  const expected = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null };
  expect(isTotpVerificationRequest({ channel, type: 'verify-page', expected })).toBe(true);
  expect(isTotpVerificationRequest({ channel, type: 'verify-page', expected: { ...expected, secret: 'a'.repeat(1000) } })).toBe(false);
});
