export type SecretCandidate =
  | { kind: 'key'; value: string; keyId?: string }
  | { kind: 'card'; cardNumber: string; cardholderName: string; expiryMonth: string; expiryYear: string; cvv?: string; scopeId?: string };

export function isSecretCandidate(value: unknown): value is SecretCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const text = (key: string, max: number, min = 0) => typeof item[key] === 'string' && (item[key] as string).length >= min && (item[key] as string).length <= max && !/[\u0000-\u001f\u007f]/.test(item[key] as string);
  const allowed = item.kind === 'key' ? ['kind','value','keyId'] : ['kind','cardNumber','cardholderName','expiryMonth','expiryYear','cvv','scopeId'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (item.kind === 'key') return text('value',4096,8) && (item.keyId === undefined || text('keyId',256,1));
  return item.kind === 'card' && text('cardNumber',19,12) && /^\d+$/.test(item.cardNumber as string)
    && text('cardholderName',256) && text('expiryMonth',2) && /^(?:0?[1-9]|1[0-2])?$/.test(item.expiryMonth as string)
    && text('expiryYear',4) && /^(?:\d{2}|\d{4})?$/.test(item.expiryYear as string)
    && (item.scopeId === undefined || typeof item.scopeId === 'string' && /^[a-f0-9]{32}$/.test(item.scopeId))
    && (item.cvv === undefined || text('cvv',4,3) && /^\d{3,4}$/.test(item.cvv as string));
}

import type { ManualEntrySaveInput } from '../../background/vault/protocol2/service';
export const SECRET_CAPTURE_CHANNEL = 'palladin.secret-capture.v1' as const;
export type SecretCaptureContentCommand =
  | { channel: typeof SECRET_CAPTURE_CHANNEL; type: 'observe'; documentId: string; candidate: SecretCandidate }
  | { channel: typeof SECRET_CAPTURE_CHANNEL; type: 'status' | 'dismiss' | 'open'; documentId: string; id?: string };
export type SecretCapturePopupCommand =
  | { channel: typeof SECRET_CAPTURE_CHANNEL; type: 'get' }
  | { channel: typeof SECRET_CAPTURE_CHANNEL; type: 'dismiss' | 'mute' | 'begin-review'; id: string }
  | { channel: typeof SECRET_CAPTURE_CHANNEL; type: 'save'; id: string; vaultId: string; entry: ManualEntrySaveInput };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export interface SecretCaptureInvalidation { type: 'secret-capture/invalidated'; candidateIds?: readonly string[] }
export function isSecretCaptureInvalidation(value: unknown): value is SecretCaptureInvalidation {
  return record(value) && value.type === 'secret-capture/invalidated' && keys(value, ['type', 'candidateIds'])
    && (value.candidateIds === undefined || Array.isArray(value.candidateIds) && value.candidateIds.length <= 8 && value.candidateIds.every(id));
}
export function isSecretCaptureContentCommand(value: unknown): value is SecretCaptureContentCommand {
  if (!record(value) || value.channel !== SECRET_CAPTURE_CHANNEL || !id(value.documentId)) return false;
  return value.type === 'observe' ? keys(value, ['channel','type','documentId','candidate']) && isSecretCandidate(value.candidate)
    && (value.candidate.kind !== 'card' || typeof value.candidate.scopeId === 'string')
    : ['status','dismiss','open'].includes(String(value.type)) && keys(value, ['channel','type','documentId','id']) && (value.id === undefined || id(value.id));
}
export function isSecretCapturePopupCommand(value: unknown, validEntry: (entry: unknown) => entry is ManualEntrySaveInput): value is SecretCapturePopupCommand {
  if (!record(value) || value.channel !== SECRET_CAPTURE_CHANNEL) return false;
  if (value.type === 'get') return keys(value, ['channel','type']);
  if (value.type === 'dismiss' || value.type === 'mute' || value.type === 'begin-review') return id(value.id) && keys(value, ['channel','type','id']);
  return value.type === 'save' && keys(value, ['channel','type','id','vaultId','entry']) && id(value.id) && id(value.vaultId)
    && validEntry(value.entry) && (value.entry.entryType === 'key' || value.entry.entryType === 'creditCard');
}
