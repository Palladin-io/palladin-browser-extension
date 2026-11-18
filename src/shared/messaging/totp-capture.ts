import type { CapturedTotpIdentityFields } from '@shared/totp-capture';
export const TOTP_CAPTURE_CHANNEL = 'palladin.totp-capture' as const;
export interface TotpEntryRef { id: string; vaultId: string }
type Base = { channel: typeof TOTP_CAPTURE_CHANNEL };
export type TotpContentCommand = Base & { documentId: string } & (
  | { type: 'observe'; uri: string; sequence: number; manual: boolean } | { type: 'open' | 'mute'; id: string } | { type: 'invalidate'; sequence: number } | { type: 'advance'; sequence: number });
export type TotpPopupCommand = Base & (
  | { type: 'get' } | { type: 'scan'; entry: TotpEntryRef } | { type: 'dismiss'; id: string } | { type: 'mute'; id: string }
  | { type: 'save'; id: string; targetId: string; replace: boolean; confirmDomainMismatch?: boolean; create?: { label: string; username: string } });
function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function only(x: Record<string, unknown>, keys: string[]): boolean { return Object.keys(x).every(key => keys.includes(key)); }
function bounded(x: unknown, max: number): x is string { return typeof x === 'string' && x.length > 0 && x.length <= max; }
export function isTotpContentCommand(x: unknown): x is TotpContentCommand {
  if (!record(x) || x.channel !== TOTP_CAPTURE_CHANNEL || !bounded(x.documentId, 128)) return false;
  const keys = ['channel', 'documentId', 'type'];
  if (x.type === 'observe') return only(x, [...keys, 'uri', 'sequence', 'manual']) && bounded(x.uri, 2048) && typeof x.manual === 'boolean' && Number.isSafeInteger(x.sequence) && (x.sequence as number) >= 0;
  if (x.type === 'open' || x.type === 'mute') return only(x, [...keys, 'id']) && bounded(x.id, 128);
  return (x.type === 'invalidate' || x.type === 'advance') && only(x, [...keys, 'sequence']) && Number.isSafeInteger(x.sequence) && (x.sequence as number) >= 0;
}
export function isTotpPopupCommand(x: unknown): x is TotpPopupCommand {
  if (!record(x) || x.channel !== TOTP_CAPTURE_CHANNEL) return false;
  const keys = ['channel', 'type'];
  if (x.type === 'get') return only(x, keys);
  if (x.type === 'scan') return only(x, [...keys, 'entry']) && record(x.entry) && only(x.entry, ['id', 'vaultId']) && bounded(x.entry.id, 128) && bounded(x.entry.vaultId, 128);
  if (x.type === 'dismiss' || x.type === 'mute') return only(x, [...keys, 'id']) && bounded(x.id, 128);
  if (x.type !== 'save' || !only(x, [...keys, 'id', 'targetId', 'replace', 'create', 'confirmDomainMismatch']) || !bounded(x.id, 128)
    || !bounded(x.targetId, 128) || typeof x.replace !== 'boolean' || x.confirmDomainMismatch !== undefined && typeof x.confirmDomainMismatch !== 'boolean') return false;
  return x.create === undefined || (record(x.create) && only(x.create, ['label', 'username'])
    && bounded(x.create.label, 512) && typeof x.create.username === 'string' && x.create.username.length <= 512);
}

export function isTotpVerificationRequest(value: unknown): value is Base & { type: 'verify-page'; expected: CapturedTotpIdentityFields } {
  if (!record(value) || !only(value, ['channel', 'type', 'expected']) || value.channel !== TOTP_CAPTURE_CHANNEL || value.type !== 'verify-page' || !record(value.expected)) return false;
  const expected = value.expected;
  return only(expected, ['secret', 'algorithm', 'digits', 'period', 'issuer', 'account'])
    && bounded(expected.secret, 256) && (expected.algorithm === 'SHA1' || expected.algorithm === 'SHA256' || expected.algorithm === 'SHA512')
    && (expected.digits === 6 || expected.digits === 8) && Number.isInteger(expected.period) && (expected.period as number) > 0 && (expected.period as number) <= 3600
    && (expected.issuer === null || typeof expected.issuer === 'string' && expected.issuer.length <= 2048)
    && (expected.account === null || typeof expected.account === 'string' && expected.account.length <= 2048);
}
