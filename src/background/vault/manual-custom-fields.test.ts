import { expect, it } from 'vitest';
import { isManualEntrySaveInput } from './commands';
const params = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 };
const input = (value: unknown) => ({ entryType: 'key', label: 'Example', value: 'synthetic', customFields: [{ id: 'custom:authenticator', label: 'Authenticator', type: 'totp', value }] });
it('accepts a structured authenticator custom field for any entry type', () => {
  expect(isManualEntrySaveInput(input(params))).toBe(true);
});
it.each([{...params, digits: 7}, {...params, period: 0}, {...params, secret: ''}, {...params, secret: 'AA' + '='.repeat(300)}, {...params, algorithm: 'MD5'}, 'raw secret'])('rejects malformed authenticator configuration', value => {
  expect(isManualEntrySaveInput(input(value))).toBe(false);
});
