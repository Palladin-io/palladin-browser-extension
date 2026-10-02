import { z } from 'zod';
import type { ShareProtection } from './contracts';

export function sharingRecipients(input: string): string[] | null {
  const parts = input.split(',').map((part) => part.trim());
  if (
    parts.length > 20 ||
    parts.some((part) => !z.email().max(320).safeParse(part).success)
  )
    return null;
  return new Set(parts.map((part) => part.toLocaleLowerCase('en-US'))).size ===
    parts.length
    ? parts
    : null;
}

export function validShareProtection(
  protection: ShareProtection,
  secret: string | null,
): boolean {
  if (protection === 'none') return secret === null;
  if (secret === null || secret.length > 128) return false;
  if (protection === 'password') return secret.length >= 8;
  if (!/^[0-9]{6,128}$/.test(secret)) return false;
  for (const width of [1, 2, 3]) {
    if (
      secret.length >= width * 2 &&
      secret.length % width === 0 &&
      secret === secret.slice(0, width).repeat(secret.length / width)
    )
      return false;
  }
  return ![1, 9].some((step) =>
    [...secret]
      .slice(1)
      .every(
        (digit, index) =>
          (Number(digit) - Number(secret[index]) + 10) % 10 === step,
      ),
  );
}
