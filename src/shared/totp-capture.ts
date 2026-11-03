import { parseOtpauthUri, type TotpParams } from '@palladin/crypto';

/** Parse untrusted setup data with bounds before passing it to shared crypto. */
export function parseCapturedTotp(value: string): TotpParams | null {
  if (value.length > 2048 || value.length < 1 || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'otpauth:' || url.hostname !== 'totp' || url.username || url.password || url.port || url.hash) return null;
    for (const key of ['secret', 'digits', 'period', 'algorithm', 'issuer']) {
      if (url.searchParams.getAll(key).length > 1) return null;
    }
    const digits = url.searchParams.get('digits');
    const period = url.searchParams.get('period');
    const algorithm = url.searchParams.get('algorithm');
    if (digits !== null && digits !== '6' && digits !== '8') return null;
    if (period !== null && (!/^[1-9]\d{0,3}$/.test(period) || Number(period) > 3600)) return null;
    if (algorithm !== null && !['SHA1', 'SHA256', 'SHA512'].includes(algorithm.toUpperCase())) return null;
    const parsed = parseOtpauthUri(value);
    if (!parsed || ![6, 8].includes(parsed.digits) || parsed.secret.length > 256) return null;
    return parsed;
  } catch { return null; }
}

/** Canonical identity for in-memory comparison only; never expose or persist it. */
export type CapturedTotpIdentityFields = Pick<TotpParams, 'secret' | 'algorithm' | 'digits' | 'period'> & { issuer?: string | null; account?: string | null };
export function capturedTotpIdentity(value: CapturedTotpIdentityFields): string {
  return JSON.stringify([value.secret.replace(/=+$/, ''), value.algorithm, value.digits, value.period, value.issuer ?? null, value.account ?? null]);
}
