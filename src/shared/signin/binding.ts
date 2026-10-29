import { SIGN_IN_FIELD_TYPE, signInMethodValueSchema, type currentVaultPlaintext } from '@palladin/crypto';
import type { SignInProvider } from './providers';

type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1;
type CustomField = MemberSecretV1['content']['customFields'][number];

/**
 * `palladin.signin.v1` lives inside the encrypted Credential MemberSecret as a
 * canonical custom field, so it syncs with the Entry and never reaches the
 * server or the MemberIndex. With Agent access `discovery`, the shared SDK
 * projects only the provider and the provider Credential reference into Agent
 * Discovery — never the account. Contract: `docs/FEDERATED-SIGNIN.md`.
 */
export { SIGN_IN_FIELD_TYPE };
export const MAX_SIGN_IN_ACCOUNT_LENGTH = 256;

export interface SignInEntryReference {
  readonly vaultId: string;
  readonly entryId: string;
}

export interface SignInBinding {
  readonly provider: SignInProvider;
  readonly account: string | null;
  /** Discoverable provider Credential an Agent may request; set only from an explicit choice. */
  readonly entry: SignInEntryReference | null;
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
  return signInMethodValueSchema.safeParse(value).success;
}

export function readSignInBinding(secret: MemberSecretV1): SignInBindingState {
  if (secret.entryType !== 'credential') return { status: 'absent' };
  const fields = secret.content.customFields.filter((field) => field.type === SIGN_IN_FIELD_TYPE);
  if (fields.length === 0) return { status: 'absent' };
  if (fields.length > 1) return { status: 'ambiguous' };
  const field = fields[0]!;
  const parsed = signInMethodValueSchema.safeParse(field.value);
  if (!parsed.success) return { status: 'unrecognized' };
  return { status: 'recognized', fieldId: field.id,
    binding: { provider: parsed.data.provider, account: parsed.data.account, entry: parsed.data.entry } };
}

/**
 * Replaces every sign-in field with exactly one (or removes them). A replaced
 * recognized field keeps its Agent access; a new one is discoverable exactly
 * when the Credential itself is discoverable. All other fields and policies are
 * preserved unchanged.
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
  const previous = readSignInBinding(secret);
  const previousAccess = previous.status === 'recognized' ? secret.agentFieldAccess[previous.fieldId] : undefined;
  const removed = new Set(secret.content.customFields
    .filter((field) => field.type === SIGN_IN_FIELD_TYPE).map((field) => field.id));
  const kept = secret.content.customFields.filter((field) => !removed.has(field.id));
  const agentFieldAccess = Object.fromEntries(Object.entries(secret.agentFieldAccess)
    .filter(([id]) => !removed.has(id))) as MemberSecretV1['agentFieldAccess'];
  const customFields: CustomField[] = [...kept];
  if (binding !== null) {
    const id = `custom:${createId().toLowerCase()}`;
    const entry = binding.entry === null ? null
      : { vaultId: binding.entry.vaultId.toLowerCase(), entryId: binding.entry.entryId.toLowerCase() };
    customFields.push({ id, label: label.normalize('NFC').trim().slice(0, 128) || 'Sign-in method',
      type: SIGN_IN_FIELD_TYPE, value: { provider: binding.provider, account, entry } });
    agentFieldAccess[id] = previousAccess === 'never' || previousAccess === 'discovery'
      ? previousAccess : secret.discoverable ? 'discovery' : 'never';
  }
  return { ...secret, agentFieldAccess, content: { ...secret.content, customFields } };
}

/** Exact, case-insensitive comparison for provider account identifiers. */
export function sameSignInAccount(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.normalize('NFC').trim().toLocaleLowerCase('en') === right.normalize('NFC').trim().toLocaleLowerCase('en');
}

export function sameSignInEntry(left: SignInEntryReference | null, right: SignInEntryReference | null): boolean {
  if (left === null || right === null) return left === right;
  return left.vaultId.toLowerCase() === right.vaultId.toLowerCase() && left.entryId.toLowerCase() === right.entryId.toLowerCase();
}
