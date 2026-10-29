import type { currentVaultPlaintext } from '@palladin/crypto';
import { isSignInProvider, type SignInProvider } from './providers';

type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1;
type CustomField = MemberSecretV1['content']['customFields'][number];

/**
 * `palladin.signin.v1` lives inside the encrypted Credential MemberSecret as a
 * canonical custom field, so it syncs with the Entry and never reaches the
 * server, agents, discovery or the MemberIndex. Contract: brain
 * `Technical/Federated Sign-in Methods.md`.
 */
export const SIGN_IN_FIELD_TYPE = 'palladin.signin.v1';
export const MAX_SIGN_IN_ACCOUNT_LENGTH = 256;

export interface SignInBinding {
  readonly provider: SignInProvider;
  readonly account: string | null;
}

export type SignInBindingState =
  | { readonly status: 'absent' }
  | { readonly status: 'recognized'; readonly binding: SignInBinding; readonly fieldId: string }
  | { readonly status: 'unrecognized' }
  | { readonly status: 'ambiguous' };

export function normalizeSignInAccount(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length === 0 ? null : normalized;
}

export function isSignInBinding(value: unknown): value is SignInBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'account' || keys[1] !== 'provider') return false;
  if (!isSignInProvider(record.provider)) return false;
  const account = record.account;
  return account === null || (typeof account === 'string' && account.length > 0
    && account.length <= MAX_SIGN_IN_ACCOUNT_LENGTH && account === account.normalize('NFC').trim());
}

export function readSignInBinding(secret: MemberSecretV1): SignInBindingState {
  if (secret.entryType !== 'credential') return { status: 'absent' };
  const fields = secret.content.customFields.filter((field) => field.type === SIGN_IN_FIELD_TYPE);
  if (fields.length === 0) return { status: 'absent' };
  if (fields.length > 1) return { status: 'ambiguous' };
  const field = fields[0]!;
  if (!isSignInBinding(field.value)) return { status: 'unrecognized' };
  return { status: 'recognized', binding: { provider: field.value.provider, account: field.value.account }, fieldId: field.id };
}

/**
 * Replaces every sign-in field with exactly one (or removes them) and keeps the
 * canonical Agent policy `never` for the new field. All other fields and
 * policies are preserved unchanged.
 */
export function withSignInBinding(
  secret: MemberSecretV1,
  binding: SignInBinding | null,
  label: string,
  createId: () => string = () => crypto.randomUUID(),
): MemberSecretV1 {
  if (secret.entryType !== 'credential') throw new Error('Sign-in methods require a Credential');
  const account = binding === null ? null : normalizeSignInAccount(binding.account);
  if (account !== null && account.length > MAX_SIGN_IN_ACCOUNT_LENGTH) throw new Error('Sign-in account is too long');
  const removed = new Set(secret.content.customFields
    .filter((field) => field.type === SIGN_IN_FIELD_TYPE).map((field) => field.id));
  const kept = secret.content.customFields.filter((field) => !removed.has(field.id));
  const agentFieldAccess = Object.fromEntries(Object.entries(secret.agentFieldAccess)
    .filter(([id]) => !removed.has(id))) as MemberSecretV1['agentFieldAccess'];
  const customFields: CustomField[] = [...kept];
  if (binding !== null) {
    const id = `custom:${createId().toLowerCase()}`;
    customFields.push({ id, label: label.normalize('NFC').trim().slice(0, 128) || 'Sign-in method',
      type: SIGN_IN_FIELD_TYPE, value: { provider: binding.provider, account } });
    agentFieldAccess[id] = 'never';
  }
  return { ...secret, agentFieldAccess, content: { ...secret.content, customFields } };
}

/** Exact, case-insensitive comparison for provider account identifiers. */
export function sameSignInAccount(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.normalize('NFC').trim().toLocaleLowerCase('en') === right.normalize('NFC').trim().toLocaleLowerCase('en');
}
