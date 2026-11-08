import { secretCaptureFrames, currentCaptureDocument, resolveCaptureSource } from './document-route-runtime';
import { activePageTab } from '../active-page-tab';
import { cardNetworkDomain } from '@shared/card-network';
import { isExactCapturedSecret } from './secret-duplicate';
import type { SecretCaptureContentCommand, SecretCapturePopupCommand, SecretCaptureInvalidation } from '@shared/messaging/secret-capture';
import { initializeServerConfig, serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { vaultData, credentialWriter } from '../vault/runtime';
import { SecretCaptureCoordinator } from './secret-coordinator';
import { capturePreferences } from './preferences-runtime';
import { hasVaultManagePermission } from './permissions';

let generation = 0;
export function publishSecretCaptureInvalidation(candidateIds: readonly string[]): void {
  if (candidateIds.length) void chrome.runtime.sendMessage({ type: 'secret-capture/invalidated', candidateIds } satisfies SecretCaptureInvalidation).catch(() => undefined);
}
export { secretCaptureFrames };
export const currentSecretCaptureDocument = currentCaptureDocument;
export const secretCaptureCoordinator = new SecretCaptureCoordinator({
  session: async () => {
    await initializeServerConfig(); const userId = await sessionManager.getUserId();
    return userId ? { profileId: `${serverConfig.apiUrl}:${userId}`, generation, unlocked: sessionManager.getKeys() !== null } : null;
  },
  current: currentSecretCaptureDocument,
  activeTabId: async () => (await activePageTab())?.id ?? null,
  muted: (profile, host) => capturePreferences.isMuted(profile, host),
  mute: (profile, host) => capturePreferences.mute(profile, host),
  vaults: async () => hasVaultManagePermission(await sessionManager.getAccessToken()) ? vaultData.sharedCopyVaults() : [],
  resolveIcon: async (candidate, origin) => {
    const domain = candidate.kind === 'card' ? cardNetworkDomain(candidate.cardNumber) : new URL(origin).hostname;
    return domain ? credentialWriter.captureIcon(`https://${domain}`) : undefined;
  },
  cardTargets: pan => credentialWriter.cardChoices(pan),
  update: (target, entry, pan, authorized) => credentialWriter.updateCard(target, entry, pan, authorized),
  duplicate: async (entry, vaultId) => {
    const metadata = await vaultData.getMetadata();
    for (const item of metadata.filter(item => item.vaultId === vaultId && item.type === (entry.entryType === 'key' ? 0 : 3))) {
      const previous = await vaultData.revealEntry(vaultId, item.id);
      if (isExactCapturedSecret(entry, previous)) return true;
    }
    return false;
  },
  save: (entry, vaultId, authorized, current) => vaultData.saveEntry(entry, vaultId, async () => {
    if (!await authorized() || !hasVaultManagePermission(await sessionManager.getAccessToken())) throw Error('Capture authorization changed');
  }, current),
});
sessionManager.hooks.onTerminating(() => {
  generation++; secretCaptureCoordinator.clear();
  void chrome.runtime.sendMessage({ type: 'secret-capture/invalidated' }).catch(() => undefined);
});
sessionManager.hooks.onLocked(() => { generation++; secretCaptureCoordinator.clear(); });
sessionManager.hooks.onUnlocked(() => { generation++; secretCaptureCoordinator.clear(); });
export async function handleSecretCapturePopup(command: SecretCapturePopupCommand) {
  if (command.type === 'get') return secretCaptureCoordinator.review();
  if (command.type === 'begin-review') return secretCaptureCoordinator.beginReview(command.id);
  if (command.type === 'dismiss' || command.type === 'mute') return secretCaptureCoordinator.dismiss(command.id, command.type === 'mute');
  if (command.type === 'update') return secretCaptureCoordinator.update(command.id, command.targetId, command.entry);
  if (command.type !== 'save') return { status: 'error' as const };
  return secretCaptureCoordinator.save(command.id, command.vaultId, command.entry);
}
export async function handleSecretCaptureContent(command: SecretCaptureContentCommand, sender: chrome.runtime.MessageSender) {
  const source = await resolveCaptureSource(sender, command.documentId);
  if (!source) return { status: 'stale' };
  if (command.type === 'observe') return secretCaptureCoordinator.observe(command.candidate, source);
  return secretCaptureCoordinator.contentStatus(source, command.type === 'dismiss' || command.type === 'mute' ? command.id : undefined, command.type === 'mute');
}
