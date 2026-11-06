import { activePageTab } from '../active-page-tab';
import { TOTP_CAPTURE_CHANNEL, type TotpContentCommand, type TotpPopupCommand } from '@shared/messaging/totp-capture';
import { initializeServerConfig, serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { credentialWriter } from '../vault/runtime';
import { currentSecretCaptureDocument, secretCaptureFrames } from './secret-runtime';
import type { CapturedTotp } from '../vault/protocol2/credential-writer';
import type { SecretCaptureSource } from './secret-coordinator';
import { TotpCaptureCoordinator } from './totp-coordinator';
let generation = 0;
const observationSequences = new Map<number, { document: string; sequence: number }>();
export function clearTotpObservation(tabId: number): void { observationSequences.delete(tabId); }
export const totpCaptureCoordinator = new TotpCaptureCoordinator({
  session: async () => {
    await initializeServerConfig(); const userId = await sessionManager.getUserId();
    return userId ? { profileId: `${serverConfig.apiUrl}:${userId}`, generation, unlocked: sessionManager.getKeys() !== null } : null;
  },
  current: currentSecretCaptureDocument,
  sourceMatches: async (source: SecretCaptureSource, expected: CapturedTotp) => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const sequence = observationSequences.get(source.tabId);
        const matches = await chrome.tabs.sendMessage(source.tabId,
          { channel: TOTP_CAPTURE_CHANNEL, type: 'verify-page', expected }, { documentId: source.browserDocumentId });
        if (sequence === observationSequences.get(source.tabId)) return matches === true;
      }
      return false;
    } catch { return false; }
  },
  invalidated: publishTotpInvalidation,
  activeTabId: async () => (await activePageTab())?.id ?? null,
  choices: (url, entry) => credentialWriter.totpChoices(url, entry),
  save: (totp, url, target, authorized, create, confirmDomainMismatch) => credentialWriter.saveTotp(totp, url, target, authorized, create, confirmDomainMismatch),
});
export function publishTotpInvalidation(): void { void chrome.runtime.sendMessage({ type: 'totp-capture/invalidated' }).catch(() => undefined); }
const clearSession = () => { generation++; observationSequences.clear(); totpCaptureCoordinator.clear(); publishTotpInvalidation(); };
sessionManager.hooks.onTerminating(clearSession);
sessionManager.hooks.onLocked(clearSession);
sessionManager.hooks.onUnlocked(clearSession);
export const totpSessionGeneration = () => generation;
export async function handleTotpContent(command: TotpContentCommand, sender: chrome.runtime.MessageSender, expectedGeneration: number) {
  const source = secretCaptureFrames.source(sender, chrome.runtime.id, command.documentId);
  if (generation !== expectedGeneration || !source || source.frameId !== 0) return { status: 'stale' as const };
  const document = `${source.browserDocumentId}:${source.documentId}`;
  if (command.type === 'observe' || command.type === 'invalidate' || command.type === 'advance') {
    const previous = observationSequences.get(source.tabId);
    if (previous?.document === document && command.sequence < previous.sequence) return { status: 'stale' as const };
    observationSequences.set(source.tabId, { document, sequence: command.sequence });
    const current = () => generation === expectedGeneration && observationSequences.get(source.tabId)?.document === document
      && observationSequences.get(source.tabId)?.sequence === command.sequence;
    if (!(await currentSecretCaptureDocument(source)) || !current()) return { status: 'stale' as const };
    if (command.type === 'advance') return { status: 'advanced' as const };
    if (command.type === 'invalidate') { if (totpCaptureCoordinator.invalidateDocument(source.tabId, source.browserDocumentId)) publishTotpInvalidation(); return { status: 'dismissed' as const }; }
    return totpCaptureCoordinator.observe(command.uri, source, current, command.manual);
  }
  return { status: 'stale' as const };
}
export async function handleTotpPopup(command: TotpPopupCommand) {
  if (command.type === 'get') return totpCaptureCoordinator.review();
  if (command.type === 'dismiss') { await totpCaptureCoordinator.dismiss(command.id); publishTotpInvalidation(); return { status: 'dismissed' as const }; }
  if (command.type === 'save') return totpCaptureCoordinator.save(command.id, command.targetId, command.replace, command.create, command.confirmDomainMismatch);
  const tab = await activePageTab();
  if (typeof tab?.id !== 'number') return { status: 'empty' as const };
  try {
    const found: unknown = await chrome.tabs.sendMessage(tab.id, { channel: TOTP_CAPTURE_CHANNEL, type: 'scan-page' }, { frameId: 0 });
    if (found === 'ambiguous') return { status: 'ambiguous' as const };
    if (found !== 'found') return { status: 'empty' as const };
    const review = await totpCaptureCoordinator.review(command.entry, tab.id);
    void chrome.runtime.sendMessage({ type: 'totp-capture/available' }).catch(() => undefined);
    return review;
  } catch { return { status: 'empty' as const }; }
}
