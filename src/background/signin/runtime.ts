import { currentLegacyCaptureLogin, captureDocumentRoutes, resolveCaptureSource } from '../capture/document-route-runtime';
import { FEDERATED_SIGNIN_CHANNEL, type FederatedSignInCommand, type FederatedSignInRefresh } from '@shared/messaging/federated-signin'
import { isLiveCredentialDocument } from '../capture/credential-document'
import { captureSourceFromSender } from '../capture/runtime'
import { sessionManager } from '../session/runtime'
import { browserDocumentIdForTab } from '../tab-documents'
import { credentialWriter, vaultData } from '../vault/runtime'
import { FederatedSignInCoordinator, type SignInSource } from './coordinator'
import { matchesTab, registrableDomain } from '@shared/security/domain'
import { normalizeSignInAccount, readSignInMethods } from '@shared/signin/binding'
import { SIGN_IN_PROVIDER_ACCOUNT_DOMAINS } from '@shared/signin/providers'
import { ENTRY_TYPE_CREDENTIAL } from '../vault/entry-metadata'

let sessionGeneration = 0

export const federatedSignIn = new FederatedSignInCoordinator({
  getSession: async () => (await sessionManager.getUserId()) === null ? null
    : { unlocked: sessionManager.getKeys() !== null, generation: sessionGeneration },
  providerAccounts: async (provider) => {
    const domains = SIGN_IN_PROVIDER_ACCOUNT_DOMAINS[provider]
    const candidates = (await vaultData.getMetadata()).filter((entry) => entry.type === ENTRY_TYPE_CREDENTIAL
      && entry.username && domains.includes(registrableDomain(entry.urlDomain) ?? '')).slice(0, 20)
    const accounts = []
    for (const entry of candidates) {
      const account = normalizeSignInAccount(entry.username ?? null)
      if (account === null) continue
      try {
        // Recheck the opened head: sync may have changed its type or site since the index scan.
        const secret = await vaultData.revealCurrentEntry(entry.vaultId, entry.id)
        if (secret.entryType !== 'credential' || !domains.includes(registrableDomain(secret.content.urlDomain) ?? '')) continue
        const current = normalizeSignInAccount(secret.content.username)
        if (current === null) continue
        // Only a discoverable provider Credential may become an Agent-visible reference.
        accounts.push({ ...(secret.icon ? { icon: secret.icon.kind === 'glyph' ? secret.icon.value : `public-asset:${secret.icon.assetId}` } : {}), account: current, context: `${secret.memberLabel} \u00b7 ${entry.vaultName}`,
          entry: secret.discoverable ? { vaultId: entry.vaultId, entryId: entry.id } : null })
      } catch { /* An unreadable cached Entry is not offered. */ }
    }
    return accounts
  },
  targets: (url) => credentialWriter.signInTargets(url),
  localBindings: async (url) => {
    const metadata = (await vaultData.getMetadata()).filter((entry) => entry.type === ENTRY_TYPE_CREDENTIAL
      && matchesTab(url, entry.urlDomain))
    const credentials = []
    for (const entry of metadata) {
      try {
        const secret = await vaultData.revealCurrentEntry(entry.vaultId, entry.id)
        if (secret.entryType !== 'credential' || !matchesTab(url, secret.content.urlDomain)) continue
        for (const method of readSignInMethods(secret)) credentials.push({ vaultId: entry.vaultId, entryId: entry.id, revision: '', label: secret.memberLabel,
          username: secret.content.username, vaultLabel: entry.vaultName, signIn: { status: 'recognized' as const, fieldId: method.id, binding: method.binding } })
      } catch { /* A stale or inconsistent cached Entry is skipped, never fatal. */ }
    }
    return credentials
  },
  save: (url, target, binding, label, stillAuthorized, entryName) => credentialWriter.saveSignIn(url, target, binding, label, stillAuthorized, entryName),
  isCurrentDocument: (source) => isLiveCredentialDocument(source, browserDocumentIdForTab,
    (tabId, message, options) => chrome.tabs.sendMessage(tabId, message, options), currentLegacyCaptureLogin),
  notify(tabId) {
    const documentId = browserDocumentIdForTab(tabId)
    const refresh: FederatedSignInRefresh = { channel: FEDERATED_SIGNIN_CHANNEL, type: 'refresh' }
    if (documentId !== null) void chrome.tabs.sendMessage(tabId, refresh, { documentId }).catch(() => undefined)
    else if (captureDocumentRoutes) void captureDocumentRoutes.resolve(tabId).then(source => {
      // This notification carries no values; its receiver resolves its own current source.
      if (source) return chrome.tabs.sendMessage(tabId, refresh, { frameId: 0 });
    }).catch(() => undefined)
  },
})

sessionManager.hooks.onLocked(() => { sessionGeneration += 1; federatedSignIn.clear() })
sessionManager.hooks.onUnlocked(() => { sessionGeneration += 1 })

export async function federatedSignInSource(command: FederatedSignInCommand, sender: chrome.runtime.MessageSender): Promise<SignInSource | null> {
  const source = sender.documentId == null ? await resolveCaptureSource(sender, command.documentId) : captureSourceFromSender(sender, chrome.runtime.id)
  if (source === null || sender.frameId !== 0 || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) return null
  return { ...source, documentId: command.documentId }
}
