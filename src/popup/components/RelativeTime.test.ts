import { expect, it } from 'vitest';
import { relativeTime } from './RelativeTime';
it('formats past and future dates in the selected language', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  expect(relativeTime('2026-11-03T11:55:00Z', 'en', now)).toBe('5 minutes ago');
  expect(relativeTime('2026-11-03T14:00:00Z', 'pl', now)).toBe('za 2 godziny');
  expect(relativeTime('invalid', 'pl', now)).toBe('—');
});
