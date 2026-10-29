import { isSecretCapturePopupCommand, type SecretCapturePopupCommand } from '@shared/messaging/secret-capture';
import { isTrustedExtensionPage, type RuntimeSenderIdentity } from '../trusted-sender';
import { isManualEntrySaveInput } from '../vault/commands';
import type { SecretCaptureResult } from './secret-coordinator';
export function dispatchSecretCapturePopup(
  raw: unknown, sender: RuntimeSenderIdentity, runtimeId: string, origin: string,
  dispatch: (command: SecretCapturePopupCommand) => Promise<SecretCaptureResult>,
): Promise<SecretCaptureResult> | null {
  if (!isTrustedExtensionPage(sender, runtimeId, origin) || !isSecretCapturePopupCommand(raw, isManualEntrySaveInput)) return null;
  return dispatch(raw);
}
