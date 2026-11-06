import { currentLegacyCaptureLogin, captureDocumentRoutes, resolveCaptureSource } from './document-route-runtime';
import type { CredentialCaptureCommand } from '@shared/messaging/credential-capture'
import { initializeServerConfig, serverConfig } from '../config/server-runtime'
import { sessionManager } from '../session/runtime'
import { browserDocumentIdForTab } from '../tab-documents'
import { credentialWriter } from '../vault/runtime'
import { CredentialCaptureCoordinator, type CredentialCaptureSource } from './credential-coordinator'
import { captureSourceFromSender } from './runtime'
import { isLiveCredentialDocument } from './credential-document'

import { capturePreferences } from './preferences-runtime'

let sessionGeneration = 0

export const credentialCaptureCoordinator = new CredentialCaptureCoordinator({
  getSession: async () => {
    await initializeServerConfig()
    const userId = await sessionManager.getUserId()
    return userId === null ? null : { profileId: `${serverConfig.apiUrl}:${userId}`,
      unlocked: sessionManager.getKeys() !== null, generation: sessionGeneration }
  },
  isSubmissionDocument: (source) => source.legacyRouteId ? captureDocumentRoutes?.isRegistered(source) === true : !!source.browserDocumentId && browserDocumentIdForTab(source.tabId) === source.browserDocumentId,
  isCurrentDocument: (source) => isLiveCredentialDocument(source, browserDocumentIdForTab,
    (tabId, message, options) => chrome.tabs.sendMessage(tabId, message, options), currentLegacyCaptureLogin),
  icon: url => credentialWriter.captureIcon(url),
  choices: (credential, url) => credentialWriter.choices(credential, url),
  save: (credential, url, target, stillAuthorized, review) => credentialWriter.save(credential, url, target, stillAuthorized, review),
  preferences: capturePreferences,
})

sessionManager.hooks.onLocked(() => { sessionGeneration += 1; credentialCaptureCoordinator.clear() })
sessionManager.hooks.onUnlocked(() => { sessionGeneration += 1 })

export async function credentialCaptureSource(command: CredentialCaptureCommand, sender: chrome.runtime.MessageSender): Promise<CredentialCaptureSource | null> {
  const source = sender.documentId == null ? await resolveCaptureSource(sender, command.documentId) : captureSourceFromSender(sender, chrome.runtime.id)
  if (source === null || sender.frameId !== 0 || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) return null
  return { ...source, documentId: command.documentId }
}
