import type { InlineCaptureKind, InlineCaptureReviewCommand, InlineCaptureReviewResult } from '../../shared/messaging/inline-capture-review';
import type { SecretCaptureSource } from './secret-coordinator';
import { matchesLoginCapture, handleScopedLoginCapture } from './native-login';
import { secretCaptureCoordinator } from './secret-runtime';
import { totpCaptureCoordinator } from './totp-runtime';

export function matchesInlineCapture(kind: InlineCaptureKind, id: string, source: SecretCaptureSource): Promise<boolean> {
  if (kind === 'login') return matchesLoginCapture(source, id);
  return kind === 'secret' ? secretCaptureCoordinator.matchesSource(id, source) : totpCaptureCoordinator.matchesSource(id, source);
}

export async function dispatchInlineCapture(command: InlineCaptureReviewCommand, source: SecretCaptureSource,
  captureId: string, authorized: () => Promise<boolean>): Promise<InlineCaptureReviewResult> {
  if (command.command.type === 'open-draft' || command.command.type === 'open-saved') return {status:'stale'};
  const current = async () => await authorized() && await matchesInlineCapture(command.kind, captureId, source);
  if (!await current()) return { status: 'stale' };
  if (command.kind === 'login' && 'channel' in command.command) return handleScopedLoginCapture(command.command, source, captureId, authorized);
  if (command.kind === 'secret') {
    const operation = command.command;
    if ('id' in operation && operation.id !== captureId) return { status: 'stale' };
    if (operation.type === 'get' || operation.type === 'begin-review') {
      const result = await secretCaptureCoordinator.beginReview(captureId);
      return await current() ? result : { status: 'stale' };
    }
    if (operation.type === 'dismiss') return secretCaptureCoordinator.dismiss(captureId);
    if (operation.type === 'update') return secretCaptureCoordinator.update(captureId, operation.targetId, operation.entry, current);
    if (operation.type === 'save') return secretCaptureCoordinator.save(captureId, operation.vaultId, operation.entry, current);
    return { status: 'stale' };
  }
  if (command.kind !== 'totp') return {status:'stale'};
  const operation = command.command;
  if ('id' in operation && operation.id !== captureId) return { status: 'stale' };
  if (operation.type === 'get') {
    const result = await totpCaptureCoordinator.review(undefined, source.tabId);
    return await current() && result.status === 'ready' && result.id === captureId ? result : { status: 'stale' };
  }
  if (operation.type === 'dismiss') { await totpCaptureCoordinator.dismiss(captureId); return { status: 'dismissed' }; }
  if (command.kind !== 'totp' || operation.type !== 'save') return {status:'stale'};
  return totpCaptureCoordinator.save(captureId, operation.targetId, operation.replace, operation.create, operation.confirmDomainMismatch, current);
}
