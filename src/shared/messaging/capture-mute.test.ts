import { expect, it } from 'vitest';
import { isSecretCaptureContentCommand } from './secret-capture';
import { isTotpContentCommand, isTotpPopupCommand } from './totp-capture';
import { isFederatedSignInCommand } from './federated-signin';
import { isNativeLoginCaptureCommand } from './native-login-capture';
import { isInlineCaptureReviewCommand } from './inline-capture-review';
import { isManualEntrySaveInput } from '../../background/vault/commands';

const commands = [
  { channel: 'palladin.secret-capture.v1', type: 'mute', documentId: 'document-123456789', id: 'capture' },
  { channel: 'palladin.totp-capture', type: 'mute', documentId: 'document-123456789', id: 'capture' },
  { channel: 'palladin.totp-capture', type: 'mute', id: 'capture' },
  { channel: 'palladin.federated-signin', type: 'mute', documentId: 'document-123456789', promptId: 'capture-123456789' },
  { channel: 'palladin.native-login-capture', type: 'mute', kind: 'credential', promptId: 'capture-123456789' },
];
const validators = [isSecretCaptureContentCommand, isTotpContentCommand, isTotpPopupCommand, isFederatedSignInCommand,
  (value: unknown) => isNativeLoginCaptureCommand(value, isManualEntrySaveInput)];
it.each(commands.map((command, index) => ({ command, validate: validators[index]! })))('accepts a bound mute and rejects caller-selected scope: $command.channel', ({ command, validate }) => {
  expect(validate(command)).toBe(true);
  expect(validate({ ...command, domain: 'other.example', profileId: 'other-profile' })).toBe(false);
  expect(validate({ ...command, id: undefined, promptId: undefined })).toBe(false);
});
it.each(['secret', 'totp', 'login'] as const)('allows capture-only %s mute without widening other operations', kind => {
  const command = kind === 'login' ? commands[4] : { channel: kind === 'secret' ? 'palladin.secret-capture.v1' : 'palladin.totp-capture', type: 'mute', id: 'capture' };
  const envelope = { channel: 'palladin.inline-capture-review.v1', capability: 'a'.repeat(64), kind, command };
  expect(isInlineCaptureReviewCommand(envelope, isManualEntrySaveInput)).toBe(true);
  expect(isInlineCaptureReviewCommand({ ...envelope, command: { ...command, domain: 'other.example' } }, isManualEntrySaveInput)).toBe(false);
});
