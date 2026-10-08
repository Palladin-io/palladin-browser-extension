import { expect, it } from 'vitest';
import { sharingRecipients, validShareProtection } from './sharing-input';
it('accepts distinct named recipients and rejects duplicates, invalid addresses and overlarge batches', () => {
  expect(sharingRecipients(' a@example.test, b@example.test ')).toEqual([
    'a@example.test',
    'b@example.test',
  ]);
  expect(sharingRecipients('a@example.test,A@example.test')).toBeNull();
  expect(sharingRecipients('not-an-email')).toBeNull();
  expect(
    sharingRecipients(
      Array.from({ length: 21 }, (_, i) => `a${i}@example.test`).join(','),
    ),
  ).toBeNull();
});
it('preserves password whitespace and rejects predictable or short PINs', () => {
  expect(validShareProtection('password', '  word  ')).toBe(true);
  for (const value of [
    '123456',
    '987654',
    '111111',
    '121212',
    '123123',
    '123',
    'abc123',
  ])
    expect(validShareProtection('pin', value)).toBe(false);
  expect(validShareProtection('pin', '739284')).toBe(true);
  expect(validShareProtection('none', 'unexpected')).toBe(false);
});
