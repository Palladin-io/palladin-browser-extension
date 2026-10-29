import { FEDERATED_SIGNIN_CHANNEL, type FederatedSignInCommand, type FederatedSignInRefresh } from '@shared/messaging/federated-signin'
import { isLiveCredentialDocument } from '../capture/credential-document'
import { captureSourceFromSender } from '../capture/runtime'
import { sessionManager } from '../session/runtime'
import { browserDocumentIdForTab } from '../tab-documents'
import { credentialWriter, vaultData } from '../vault/runtime'
import { FederatedSignInCoordinator, type SignInSource } from './coordinator'
import { matchesTab, registrableDomain } from '@shared/security/domain'
import { normalizeSignInAccount, readSignInBinding } from '@shared/signin/binding'
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
        // Only a discoverable provider Credential may become an Agent-visible reference.
        const secret = await vaultData.revealCurrentEntry(entry.vaultId, entry.id)
        accounts.push({ account, entry: secret.discoverable ? { vaultId: entry.vaultId, entryId: entry.id } : null })
      } catch { accounts.push({ account, entry: null }) }
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
        credentials.push({ vaultId: entry.vaultId, entryId: entry.id, revision: '', label: secret.memberLabel,
          username: secret.content.username, vaultLabel: entry.vaultName, signIn: readSignInBinding(secret) })
      } catch { /* A stale or inconsistent cached Entry is skipped, never fatal. */ }
    }
    return credentials
  },
  save: (url, target, binding, label, stillAuthorized) => credentialWriter.saveSignIn(url, target, binding, label, stillAuthorized),
  isCurrentDocument: (source) => isLiveCredentialDocument(source, browserDocumentIdForTab,
    (tabId, message, options) => chrome.tabs.sendMessage(tabId, message, options)),
  notify(tabId) {
    const documentId = browserDocumentIdForTab(tabId)
    if (documentId === null) return
    const refresh: FederatedSignInRefresh = { channel: FEDERATED_SIGNIN_CHANNEL, type: 'refresh' }
    void chrome.tabs.sendMessage(tabId, refresh, { documentId }).catch(() => undefined)
  },
})

sessionManager.hooks.onLocked(() => { sessionGeneration += 1; federatedSignIn.clear() })
sessionManager.hooks.onUnlocked(() => { sessionGeneration += 1 })

export function federatedSignInSource(command: FederatedSignInCommand, sender: chrome.runtime.MessageSender): SignInSource | null {
  const source = captureSourceFromSender(sender, chrome.runtime.id)
  if (source === null || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) return null
  return { ...source, documentId: command.documentId }
}
