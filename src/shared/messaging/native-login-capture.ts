import type { ManualEntrySaveInput } from '../../background/vault/protocol2/service';
import type { CredentialCapturePrompt, CredentialCaptureResult, UsernameChoice } from './credential-capture';
import type { FederatedSignInResult, SignInLocale, SignInPrompt } from './federated-signin';

export const NATIVE_LOGIN_CAPTURE_CHANNEL = 'palladin.native-login-capture' as const;
export type CapturedLoginEntry = Extract<ManualEntrySaveInput, { entryType: 'credential' }>;
interface Base { channel: typeof NATIVE_LOGIN_CAPTURE_CHANNEL }
export type NativeLoginCaptureCommand = Base & (
  | { type: 'get'; targetId?: string }
  | { type: 'check'; promptId: string }
  | { type: 'save'; promptId: string; targetId: string; autoUpdate: boolean; entry: CapturedLoginEntry }
  | { type: 'choose-username'; promptId: string; choice: UsernameChoice }
  | { type: 'confirm'; promptId: string; accountId: string; targetId: string; locale: SignInLocale; replace: boolean }
  | { type: 'dismiss'; kind: 'credential' | 'federated'; promptId: string }
);
export type NativeLoginCaptureReview =
  | { kind: 'credential'; prompt: CredentialCapturePrompt; entry: CapturedLoginEntry }
  | { kind: 'federated'; prompt: SignInPrompt; icon?: string; providerIcon?: string };
export type NativeLoginCaptureResult =
  | { status: 'review'; review: NativeLoginCaptureReview | null; sourceTabId?: number }
  | { status: 'availability'; available: boolean }
  | CredentialCaptureResult | FederatedSignInResult;

export function isNativeLoginCaptureCommand(value: unknown, validEntry: (entry: unknown) => entry is ManualEntrySaveInput): value is NativeLoginCaptureCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.channel !== NATIVE_LOGIN_CAPTURE_CHANNEL) return false;
  const keys = (...allowed: string[]) => Object.keys(item).every(key => ['channel', 'type', ...allowed].includes(key));
  const id = (field: string) => typeof item[field] === 'string' && (item[field] as string).length > 0 && (item[field] as string).length <= 128;
  switch (item.type) {
    case 'check': return keys('promptId') && id('promptId');
    case 'get': return keys('targetId') && (item.targetId === undefined || id('targetId'));
    case 'save': return keys('promptId', 'targetId', 'autoUpdate', 'entry') && id('promptId') && id('targetId')
      && typeof item.autoUpdate === 'boolean' && validEntry(item.entry) && item.entry.entryType === 'credential';
    case 'choose-username': return keys('promptId', 'choice') && id('promptId') && (item.choice === 'email' || item.choice === 'nickname');
    case 'confirm': return keys('promptId', 'accountId', 'targetId', 'locale', 'replace') && id('promptId') && id('accountId') && id('targetId')
      && (item.locale === 'en' || item.locale === 'pl') && typeof item.replace === 'boolean';
    case 'dismiss': return keys('promptId', 'kind') && id('promptId') && (item.kind === 'credential' || item.kind === 'federated');
    default: return false;
  }
}
