import { isCaptureDraft, type CaptureDraft } from './capture-draft';
import { isNativeLoginCaptureCommand, type NativeLoginCaptureCommand, type NativeLoginCaptureResult } from './native-login-capture';
import { isSecretCapturePopupCommand, type SecretCapturePopupCommand } from './secret-capture';
import { isTotpPopupCommand, type TotpPopupCommand } from './totp-capture';
import type { ManualEntrySaveInput } from '../../background/vault/protocol2/service';
import type { SecretCaptureResult } from '../../background/capture/secret-coordinator';
import type { handleTotpPopup } from '../../background/capture/totp-runtime';
export const INLINE_CAPTURE_REVIEW_CHANNEL = 'palladin.inline-capture-review.v1' as const;
export type InlineCaptureKind = 'login' | 'secret' | 'totp';
export type InlineCaptureNavigation = { type:'open-saved' } | { type:'open-draft'; draft:CaptureDraft };
export type InlineCaptureReviewCommand = { channel: typeof INLINE_CAPTURE_REVIEW_CHANNEL; capability: string } & (
  | { kind: InlineCaptureKind; command: InlineCaptureNavigation }
  | { kind: 'login'; command: NativeLoginCaptureCommand }
  | { kind: 'secret'; command: Exclude<SecretCapturePopupCommand, { type: 'mute' }> }
  | { kind: 'totp'; command: Exclude<TotpPopupCommand, { type: 'scan' }> }
);
export type InlineCaptureReviewResult = NativeLoginCaptureResult | SecretCaptureResult | Awaited<ReturnType<typeof handleTotpPopup>>;
export function isInlineCaptureReviewCommand(raw: unknown, validEntry: (entry: unknown) => entry is ManualEntrySaveInput): raw is InlineCaptureReviewCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).some(key => !['channel','capability','kind','command'].includes(key))
    || item.channel !== INLINE_CAPTURE_REVIEW_CHANNEL || typeof item.capability !== 'string' || !/^[a-f0-9]{64}$/.test(item.capability)) return false;
  if (item.command && typeof item.command==='object' && ['login','secret','totp'].includes(String(item.kind))) {
    const command=item.command as Record<string,unknown>;
    if(command.type==='open-saved')return Object.keys(command).length===1;
    if(command.type==='open-draft')return Object.keys(command).length===2 && isCaptureDraft(command.draft) && command.draft.kind===item.kind;
  }
  if (item.kind === 'login') return isNativeLoginCaptureCommand(item.command, validEntry);
  if (item.kind === 'secret') return isSecretCapturePopupCommand(item.command, validEntry) && item.command.type !== 'mute';
  return item.kind === 'totp' && isTotpPopupCommand(item.command) && item.command.type !== 'scan';
}
