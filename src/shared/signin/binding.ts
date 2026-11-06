import { SIGN_IN_FIELD_TYPE, SIGN_IN_FIELD_TYPE_V2, signInMethodIdSchema, signInMethodValueSchema, type currentVaultPlaintext } from '@palladin/crypto';
import type { SignInProvider } from './providers';

type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1;
type CustomField = MemberSecretV1['content']['customFields'][number];

/** Encrypted method adapters. Discovery redaction and policy enforcement belong to the shared SDK. */
export { SIGN_IN_FIELD_TYPE };

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
  const fields = secret.content.customFields.filter(field => field.type === SIGN_IN_FIELD_TYPE || field.type === SIGN_IN_FIELD_TYPE_V2);
  if (!fields.length) return { status: 'absent' };
  if (fields.length > 1) return { status: 'ambiguous' };
  const method = readSignInMethods(secret)[0];
  return method ? { status: 'recognized', fieldId: method.id, binding: method.binding } : { status: 'unrecognized' };
}

export interface SignInMethod {
  readonly id: string;
  readonly binding: SignInBinding;
  readonly agentVisible: boolean;
}

export function readSignInMethods(secret: MemberSecretV1): SignInMethod[] {
  if (secret.entryType !== 'credential') return [];
  return secret.content.customFields.flatMap(field => {
    if (field.type !== SIGN_IN_FIELD_TYPE && field.type !== SIGN_IN_FIELD_TYPE_V2) return [];
    const parsed = signInMethodValueSchema.safeParse(field.value);
    if (!parsed.success || !signInMethodIdSchema.safeParse(field.id).success) return [];
    return [{ id: field.id, binding: parsed.data,
      agentVisible: secret.agentFieldAccess[field.id] === 'discovery' }];
  });
}

/** Null ID adds; an exact recognized ID edits/removes. Unknown fields remain opaque. */
export function mutateSignInMethod(
  secret: MemberSecretV1, fieldId: string | null, binding: SignInBinding | null, label: string,
  visible?: boolean, createId: () => string = () => crypto.randomUUID(),
): MemberSecretV1 {
  if (secret.entryType !== 'credential') throw new Error('Sign-in methods require a Credential');
  const previous = fieldId === null ? undefined : readSignInMethods(secret).find(field => field.id === fieldId);
  if (fieldId !== null && !previous) throw new Error('Unknown sign-in method');
  if (fieldId === null && binding === null) throw new Error('A new method requires a value');
  const id = fieldId ?? `custom:${createId()}`;
  if (!signInMethodIdSchema.safeParse(id).success || (fieldId === null && secret.content.customFields.some(field => field.id === id))) throw new Error('Invalid sign-in method ID');
  const agentFieldAccess = { ...secret.agentFieldAccess };
  let customFields = [...secret.content.customFields];
  if (binding === null) {
    customFields = customFields.filter(field => field.id !== id);
    delete agentFieldAccess[id];
  } else {
    const value = signInMethodValueSchema.parse({ ...binding, account: normalizeSignInAccount(binding.account) });
    const field: CustomField = { id, label: previous
      ? secret.content.customFields.find(field => field.id === id)!.label
      : label.normalize('NFC').trim().slice(0, 128) || 'Sign-in method', type: SIGN_IN_FIELD_TYPE_V2, value };
    customFields = previous ? customFields.map(current => current.id === id ? field : current) : [...customFields, field];
    agentFieldAccess[id] = visible === undefined
      ? previous ? secret.agentFieldAccess[id]! : secret.discoverable ? 'discovery' : 'never'
      : visible ? 'discovery' : 'never';
  }
  return { ...secret, agentFieldAccess, content: { ...secret.content, customFields } };
}

/** Capture always adds a method; provider/account values are never identities. */
export function withSignInBinding(secret: MemberSecretV1, binding: SignInBinding, label: string,
  createId: () => string = () => crypto.randomUUID()): MemberSecretV1 {
  return mutateSignInMethod(secret, null, binding, label, undefined, createId);
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

export interface SignInMethodInput extends SignInBinding { readonly id: string; readonly agentVisible: boolean }
export function isSignInMethodInputs(value: unknown): value is SignInMethodInput[] {
  return Array.isArray(value) && value.length <= 20 && new Set(value.map(item => item?.id)).size === value.length
    && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => ['id', 'provider', 'account', 'entry', 'agentVisible'].includes(key))
      && signInMethodIdSchema.safeParse(item.id).success && typeof item.agentVisible === 'boolean'
      && item.entry === null && isSignInBinding({ provider: item.provider, account: item.account, entry: item.entry }));
}
