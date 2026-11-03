import { isExactCapturedSecret } from './secret-duplicate';
import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse } from '@shared/messaging';
import type { SecretCaptureContentCommand, SecretCapturePopupCommand, SecretCaptureInvalidation } from '@shared/messaging/secret-capture';
import { initializeServerConfig, serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { browserDocumentIdForTab } from '../tab-documents';
import { vaultData } from '../vault/runtime';
import { SecretCaptureCoordinator, type SecretCaptureSource } from './secret-coordinator';
import { SecretCaptureFrames } from './secret-source';
import { capturePreferences } from './preferences-runtime';
import { hasVaultManagePermission } from './permissions';

let generation = 0;
export function publishSecretCaptureInvalidation(candidateIds: readonly string[]): void {
  if (candidateIds.length) void chrome.runtime.sendMessage({ type: 'secret-capture/invalidated', candidateIds } satisfies SecretCaptureInvalidation).catch(() => undefined);
}
export const secretCaptureFrames = new SecretCaptureFrames(browserDocumentIdForTab);
async function current(source: SecretCaptureSource): Promise<boolean> {
  if (browserDocumentIdForTab(source.tabId) !== source.topDocumentId) return false;
  const sender = { id: chrome.runtime.id, tab: { id: source.tabId }, frameId: source.frameId, documentId: source.browserDocumentId, url: source.url } as chrome.runtime.MessageSender;
  if (!secretCaptureFrames.source(sender, chrome.runtime.id, source.documentId)) return false;
  try {
    const response = await chrome.tabs.sendMessage(source.tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { documentId: source.browserDocumentId });
    return secretCaptureFrames.source(sender, chrome.runtime.id, source.documentId) !== null
      && browserDocumentIdForTab(source.tabId) === source.topDocumentId && isTabUrlResponse(response)
      && response.documentId === source.documentId && response.url === source.url;
  } catch { return false; }
}
export const secretCaptureCoordinator = new SecretCaptureCoordinator({
  session: async () => {
    await initializeServerConfig(); const userId = await sessionManager.getUserId();
    return userId ? { profileId: `${serverConfig.apiUrl}:${userId}`, generation, unlocked: sessionManager.getKeys() !== null } : null;
  },
  current,
  activeTabId: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null,
  muted: (profile, host) => capturePreferences.isMuted(profile, host),
  mute: (profile, host) => capturePreferences.mute(profile, host),
  vaults: async () => hasVaultManagePermission(await sessionManager.getAccessToken()) ? vaultData.sharedCopyVaults() : [],
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
  if (command.type !== 'save') return { status: 'error' as const };
  return secretCaptureCoordinator.save(command.id, command.vaultId, command.entry);
}
export async function handleSecretCaptureContent(command: SecretCaptureContentCommand, sender: chrome.runtime.MessageSender) {
  const source = secretCaptureFrames.source(sender, chrome.runtime.id, command.documentId);
  if (!source) return { status: 'stale' };
  if (command.type === 'observe') return secretCaptureCoordinator.observe(command.candidate, source);
  return secretCaptureCoordinator.contentStatus(source, command.type === 'dismiss' ? command.id : undefined);
}
