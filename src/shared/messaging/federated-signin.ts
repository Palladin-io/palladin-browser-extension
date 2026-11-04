import { isSignInProvider, type SignInProvider } from '@shared/signin/providers';

/**
 * Isolated content script <-> worker vocabulary for remembering how the user
 * signs in to an external service with a federated provider. Requests carry
 * no page-provided account text: provider identity is confirmed by the worker
 * from browser-authored URLs, and accounts come only from Palladin's own data.
 */
export const FEDERATED_SIGNIN_CHANNEL = 'palladin.federated-signin' as const;

interface DocumentCommand {
  readonly channel: typeof FEDERATED_SIGNIN_CHANNEL;
  readonly documentId: string;
}

export type SignInLocale = 'en' | 'pl';

export type FederatedSignInCommand = DocumentCommand & (
  | { readonly type: 'intent'; readonly provider: SignInProvider }
  | { readonly type: 'suggest' }
  | { readonly type: 'choose'; readonly suggestionId: string }
  | { readonly type: 'get' }
  | {
      readonly type: 'confirm';
      readonly promptId: string;
      readonly accountId: string;
      readonly targetId: string;
      readonly locale: SignInLocale;
    }
  | { readonly type: 'dismiss'; readonly promptId: string }
  | { readonly type: 'unlock' }
);

/** Value-free worker -> content nudge to request the current prompt. */
export interface FederatedSignInRefresh {
  readonly channel: typeof FEDERATED_SIGNIN_CHANNEL;
  readonly type: 'refresh';
}

export interface SignInSuggestion {
  readonly id: string;
  readonly provider: SignInProvider;
  readonly account: string | null;
  readonly label: string;
  readonly vaultLabel: string;
}

/** Transport limits shared by the worker (construction) and the content guard (validation). */
export const MAX_SIGN_IN_PROMPT_ACCOUNTS = 32;
export const MAX_SIGN_IN_PROMPT_TARGETS = 64;

export type SignInAccountSource = 'chosen' | 'used' | 'saved' | 'vault' | 'none';

export interface SignInAccountOption {
  readonly id: string;
  readonly label: string;
  readonly source: SignInAccountSource;
  readonly context?: string;
}

export interface SignInTargetOption {
  readonly id: string;
  readonly action: 'update' | 'create';
  readonly label: string;
  readonly vaultLabel: string;
  readonly current: { readonly provider: SignInProvider; readonly account: string | null } | null;
}

export interface SignInPrompt {
  readonly id: string;
  readonly site: string;
  readonly provider: SignInProvider;
  readonly state: 'locked' | 'ready';
  readonly accounts: readonly SignInAccountOption[];
  readonly targets: readonly SignInTargetOption[];
  readonly defaultAccountId: string | null;
  readonly defaultTargetId: string | null;
  readonly error?: 'save-failed';
}

export type FederatedSignInResult =
  | { readonly status: 'accepted' | 'dismissed' | 'unavailable' | 'stale' }
  | { readonly status: 'suggestions'; readonly suggestions: readonly SignInSuggestion[] }
  | { readonly status: 'chosen'; readonly provider: SignInProvider }
  | { readonly status: 'prompt'; readonly prompt: SignInPrompt | null }
  | { readonly status: 'saved'; readonly action: 'created' | 'updated' };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

export function isFederatedSignInCommand(value: unknown): value is FederatedSignInCommand {
  if (!record(value) || value.channel !== FEDERATED_SIGNIN_CHANNEL || !id(value.documentId)) return false;
  const base = ['channel', 'documentId', 'type'];
  switch (value.type) {
    case 'intent':
      return only(value, [...base, 'provider']) && isSignInProvider(value.provider);
    case 'suggest':
    case 'get':
    case 'unlock':
      return only(value, base);
    case 'choose':
      return only(value, [...base, 'suggestionId']) && id(value.suggestionId);
    case 'confirm':
      return only(value, [...base, 'promptId', 'accountId', 'targetId', 'locale']) && id(value.promptId)
        && id(value.accountId) && id(value.targetId) && (value.locale === 'en' || value.locale === 'pl');
    case 'dismiss':
      return only(value, [...base, 'promptId']) && id(value.promptId);
    default:
      return false;
  }
}

export function isFederatedSignInRefresh(value: unknown): value is FederatedSignInRefresh {
  return record(value) && only(value, ['channel', 'type'])
    && value.channel === FEDERATED_SIGNIN_CHANNEL && value.type === 'refresh';
}

function binding(value: unknown): boolean {
  return value === null || (record(value) && only(value, ['provider', 'account']) && isSignInProvider(value.provider)
    && (value.account === null || text(value.account, 1, 256)));
}

function suggestion(value: unknown): value is SignInSuggestion {
  return record(value) && only(value, ['id', 'provider', 'account', 'label', 'vaultLabel']) && id(value.id)
    && isSignInProvider(value.provider) && (value.account === null || text(value.account, 1, 256))
    && text(value.label, 0, 512) && text(value.vaultLabel, 0, 512);
}

function account(value: unknown): value is SignInAccountOption {
  return record(value) && only(value, ['id', 'label', 'source', 'context']) && id(value.id) && text(value.label, 0, 512)
    && ['chosen', 'used', 'saved', 'vault', 'none'].includes(value.source as string)
    && (value.context === undefined || text(value.context, 1, 1024));
}

function target(value: unknown): value is SignInTargetOption {
  return record(value) && only(value, ['id', 'action', 'label', 'vaultLabel', 'current']) && id(value.id)
    && (value.action === 'update' || value.action === 'create') && text(value.label, 0, 1024)
    && text(value.vaultLabel, 0, 512) && binding(value.current);
}

function prompt(value: unknown): value is SignInPrompt {
  if (!record(value) || !only(value, ['id', 'site', 'provider', 'state', 'accounts', 'targets',
    'defaultAccountId', 'defaultTargetId', 'error'])) return false;
  const accounts = value.accounts;
  const targets = value.targets;
  return id(value.id) && text(value.site, 1, 253) && isSignInProvider(value.provider)
    && (value.state === 'locked' || value.state === 'ready')
    && Array.isArray(accounts) && accounts.length <= MAX_SIGN_IN_PROMPT_ACCOUNTS && accounts.every(account)
    && Array.isArray(targets) && targets.length <= MAX_SIGN_IN_PROMPT_TARGETS && targets.every(target)
    && (value.defaultAccountId === null || accounts.some((item) => (item as SignInAccountOption).id === value.defaultAccountId))
    && (value.defaultTargetId === null || targets.some((item) => (item as SignInTargetOption).id === value.defaultTargetId))
    && (value.error === undefined || value.error === 'save-failed')
    && (value.state === 'ready' || (accounts.length === 0 && targets.length === 0));
}

export function isFederatedSignInResult(value: unknown): value is FederatedSignInResult {
  if (!record(value)) return false;
  switch (value.status) {
    case 'accepted':
    case 'dismissed':
    case 'unavailable':
    case 'stale':
      return only(value, ['status']);
    case 'suggestions':
      return only(value, ['status', 'suggestions']) && Array.isArray(value.suggestions)
        && value.suggestions.length <= 20 && value.suggestions.every(suggestion);
    case 'chosen':
      return only(value, ['status', 'provider']) && isSignInProvider(value.provider);
    case 'prompt':
      return only(value, ['status', 'prompt']) && (value.prompt === null || prompt(value.prompt));
    case 'saved':
      return only(value, ['status', 'action']) && (value.action === 'created' || value.action === 'updated');
    default:
      return false;
  }
}
