import {
  openMemberIndex,
  openMemberSecret,
  openMemberVaultKey,
  openVaultDerivedEnvelope,
  presentationIconReference,
  projectAgentDiscovery,
  sealCanonicalEntry,
  wipe,
  type MemberSecretV1,
} from '@palladin/crypto'

import { matchesTab, registrableDomain } from '@shared/security/domain'

import type { VaultDataSource } from '../data-source'
import {
  ENTRY_TYPE_CREDENTIAL,
  ENTRY_TYPE_CREDIT_CARD,
  ENTRY_TYPE_KEY,
  ENTRY_TYPE_SCRIPT,
  type EntryMetadata,
  type EntryTypeCode,
} from '../entry-metadata'
import { VaultDataError } from '../errors'
import { VaultClientError } from '../transport'
import type { MemberSyncCache } from './cache'
import {
  Protocol2MutationConflictError,
  Protocol2ResetRequiredError,
  type Protocol2VaultClient,
} from './client'
import type { EncryptedVaultSummary } from './contracts'

const CACHE_PAGE_SIZE = 200

export interface Protocol2SessionAccessor {
  getAccessToken(): Promise<string | null>
  refreshAccessToken(): Promise<string | null>
  getUserId(): Promise<string | null>
  getPrivateKey(): Uint8Array | null
}

export type GeneratedPasswordSaveResult =
  | { readonly status: 'created' }
  | { readonly status: 'updated' }
  | { readonly status: 'blocked'; readonly reason: 'ambiguous-target' | 'grant-refresh-required' }

export interface SaveGeneratedPasswordInput {
  readonly kind: 'registration' | 'password-change'
  readonly site: string
  readonly url: string
  readonly password: string
}

export interface CreditCardSaveInput {
  readonly label: string
  readonly cardholderName: string
  readonly cardNumber: string
  readonly expiryMonth: string
  readonly expiryYear: string
  readonly billingAddress?: string
  readonly notes?: string
}

export type CreditCardSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'blocked'; readonly reason: 'grant-refresh-required' }

export interface Protocol2VaultDataServiceDeps {
  readonly client: Protocol2VaultClient
  readonly cache: MemberSyncCache
  readonly session: Protocol2SessionAccessor
  readonly createNamespace?: () => string
}

/** Canonical Vault Protocol 2 sync/read/write service for the MV3 worker. */
export class Protocol2VaultDataService implements VaultDataSource {
  private readonly currentVaults = new Map<string, EncryptedVaultSummary>()
  private readonly createNamespace: () => string
  private lastUserId: string | null = null

  constructor(private readonly deps: Protocol2VaultDataServiceDeps) {
    this.createNamespace = deps.createNamespace ?? (() => crypto.randomUUID())
  }

  async refresh(): Promise<EntryMetadata[]> {
    const userId = await this.deps.session.getUserId()
    if (userId === null || await this.deps.session.getAccessToken() === null) {
      await this.clearCache()
      return []
    }

    const vaults = await this.withAuth((token) => this.deps.client.listVaults(token))
    this.lastUserId = userId
    this.currentVaults.clear()
    for (const vault of vaults) {
      await this.syncVault(userId, vault)
      const active = await this.deps.cache.getActiveState(userId, vault.id)
      this.currentVaults.set(vault.id, active?.vault ?? vault)
    }
    await this.deps.cache.removeMissingVaults(userId, new Set(vaults.map((vault) => vault.id)))
    return this.getMetadata()
  }

  async getMetadata(): Promise<EntryMetadata[]> {
    const userId = await this.deps.session.getUserId()
    const privateKey = this.deps.session.getPrivateKey()
    if (userId === null || privateKey === null) return []

    const metadata: EntryMetadata[] = []
    for (const vaultId of this.currentVaults.keys()) {
      const active = await this.deps.cache.getActiveState(userId, vaultId)
      if (active === null) continue
      let vaultKey: Uint8Array | null = null
      try {
        vaultKey = await openMemberVaultKey(active.vault.memberVaultKey, privateKey)
        let afterEntryId: string | null = null
        do {
          const page = await this.deps.cache.readActiveItemPage(
            userId,
            vaultId,
            afterEntryId,
            CACHE_PAGE_SIZE,
          )
          for (const item of page.items) {
            if (item.kind !== 'head' || item.state !== 'active') continue
            const index = await openMemberIndex(item.entryKey, item.memberIndex, vaultKey, {
              organizationId: active.vault.memberVaultKey.wrappedVaultKey.descriptor.scope.organizationId,
              vaultId,
              entryId: item.entryId,
              revision: item.memberIndexRevision,
            })
            const icon = index.icon ? presentationIconReference(index.icon) : undefined
            metadata.push({
              id: item.entryId,
              vaultId,
              name: index.memberLabel,
              type: entryTypeCode(index.entryType),
              updatedAt: item.updatedAt,
              ...(index.urlDomain ? { urlDomain: index.urlDomain } : {}),
              ...(icon ? { icon } : {}),
              ...(index.color ? { color: index.color } : {}),
            })
          }
          afterEntryId = page.nextEntryId
        } while (afterEntryId !== null)
      } catch {
        throw new VaultDataError('decrypt-failed', 'Failed to decrypt Vault index')
      } finally {
        if (vaultKey !== null) wipe(vaultKey)
      }
    }
    return metadata
  }

  async revealEntry(vaultId: string, entryId: string): Promise<MemberSecretV1> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vaultId, entryId))
    const vault = await this.requireVault(vaultId)
    let vaultKey: Uint8Array | null = null
    try {
      vaultKey = await openMemberVaultKey(vault.memberVaultKey, privateKey)
      return await openMemberSecret(detail.entryKey, detail.memberSecret, vaultKey, {
        organizationId: detail.organizationId,
        vaultId,
        entryId,
        revision: detail.currentRevision,
      })
    } catch (error) {
      if (error instanceof VaultDataError) throw error
      throw new VaultDataError('decrypt-failed', 'Failed to decrypt entry')
    } finally {
      if (vaultKey !== null) wipe(vaultKey)
    }
  }

  async clearCache(): Promise<void> {
    const userId = this.lastUserId ?? await this.deps.session.getUserId()
    this.currentVaults.clear()
    if (userId !== null) await this.deps.cache.removeMissingVaults(userId, new Set())
    this.lastUserId = null
  }

  async saveGeneratedPassword(input: SaveGeneratedPasswordInput): Promise<GeneratedPasswordSaveResult> {
    const parsed = parseSecureSite(input.url)
    if (parsed === null || parsed.site !== input.site) {
      throw new VaultDataError('network', 'Capture origin is no longer valid')
    }
    if (this.currentVaults.size === 0) await this.refresh()

    if (input.kind === 'password-change') {
      const matches = (await this.getMetadata()).filter(
        (entry) => entry.type === ENTRY_TYPE_CREDENTIAL && matchesTab(input.url, entry.urlDomain),
      )
      if (matches.length > 1) return { status: 'blocked', reason: 'ambiguous-target' }
      if (matches.length === 1) {
        return this.updateCredential(matches[0]!, input.password)
      }
    }
    return this.createCredential(input.site, parsed.origin, input.password)
  }

  async saveCreditCard(input: CreditCardSaveInput): Promise<CreditCardSaveResult> {
    if (this.currentVaults.size === 0) await this.refresh()
    const cardNumber = input.cardNumber.replace(/[ -]/g, '')
    if (!/^[0-9]{8,19}$/.test(cardNumber)) {
      throw new VaultDataError('network', 'Card number is invalid')
    }
    const result = await this.createCanonicalEntry(creditCardSecret({
      ...input,
      cardNumber,
    }))
    return result.status === 'created'
      ? { status: 'saved' }
      : { status: 'blocked', reason: 'grant-refresh-required' }
  }

  private async createCredential(
    site: string,
    origin: string,
    password: string,
  ): Promise<GeneratedPasswordSaveResult> {
    return this.createCanonicalEntry(credentialSecret(site, origin, password))
  }

  private async createCanonicalEntry(
    secret: MemberSecretV1,
  ): Promise<Extract<GeneratedPasswordSaveResult, { status: 'created' | 'blocked' }>> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const vault = [...this.currentVaults.values()].find((candidate) => candidate.isDefault)
      ?? [...this.currentVaults.values()][0]
    if (vault === undefined) throw new VaultDataError('network', 'No Vault is available')
    const entryId = await this.withAuth((token) =>
      this.deps.client.issueEntryCreationChallenge(token, vault.id))
    let vaultKey: Uint8Array | null = null
    let discoveryKey: Uint8Array | null = null
    try {
      vaultKey = await openMemberVaultKey(vault.memberVaultKey, privateKey)
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, vaultKey)
      const material = await sealCanonicalEntry({
        organizationId: vault.memberVaultKey.wrappedVaultKey.descriptor.scope.organizationId,
        vaultId: vault.id,
        entryId,
        revision: '1',
        vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
        vdkVersion: vault.currentKeyEpoch.vdkVersion,
        memberKeyGeneration: vault.memberKeyGeneration,
      }, secret, vaultKey, discoveryKey, 1)
      try {
        await this.withAuth((token) => this.deps.client.createEntry(token, {
          vaultId: vault.id,
          entryId,
          ...material,
          grantEnvelopes: [],
        }))
      } catch (error) {
        if (error instanceof Protocol2MutationConflictError) {
          return { status: 'blocked', reason: 'grant-refresh-required' }
        }
        throw error
      }
      await this.refreshAfterCommittedMutation()
      return { status: 'created' }
    } finally {
      if (discoveryKey !== null) wipe(discoveryKey)
      if (vaultKey !== null) wipe(vaultKey)
    }
  }

  private async updateCredential(
    metadata: EntryMetadata,
    password: string,
  ): Promise<GeneratedPasswordSaveResult> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const [vault, detail] = await Promise.all([
      this.requireVault(metadata.vaultId),
      this.withAuth((token) => this.deps.client.getEntry(token, metadata.vaultId, metadata.id)),
    ])
    let vaultKey: Uint8Array | null = null
    let discoveryKey: Uint8Array | null = null
    try {
      vaultKey = await openMemberVaultKey(vault.memberVaultKey, privateKey)
      discoveryKey = await openVaultDerivedEnvelope(vault.discoveryKey, vaultKey)
      const previous = await openMemberSecret(detail.entryKey, detail.memberSecret, vaultKey, {
        organizationId: detail.organizationId,
        vaultId: metadata.vaultId,
        entryId: metadata.id,
        revision: detail.currentRevision,
      })
      if (previous.entryType !== 'credential') {
        throw new VaultDataError('decrypt-failed', 'Matched entry is not a credential')
      }
      const next: MemberSecretV1 = {
        ...previous,
        content: { ...previous.content, password },
      }
      const nextRevision = (BigInt(detail.currentRevision) + 1n).toString()
      const previousDiscovery = projectAgentDiscovery(previous)
      const nextDiscovery = projectAgentDiscovery(next)
      const discoveryChanged = JSON.stringify(previousDiscovery) !== JSON.stringify(nextDiscovery)
      const material = await sealCanonicalEntry({
        organizationId: detail.organizationId,
        vaultId: metadata.vaultId,
        entryId: metadata.id,
        revision: nextRevision,
        entryKeyRevision: '1',
        entryKeyVersion: detail.currentKeyVersion + 1,
        memberIndexRevision: (BigInt(detail.memberIndexRevision) + 1n).toString(),
        agentDiscoveryRevision: (BigInt(detail.agentDiscoveryRevisionHighWatermark) + 1n).toString(),
        vaultKeyVersion: vault.currentKeyEpoch.vaultKeyVersion,
        vdkVersion: vault.currentKeyEpoch.vdkVersion,
        memberKeyGeneration: vault.memberKeyGeneration,
      }, next, vaultKey, discoveryKey, 2)
      try {
        await this.withAuth((token) => this.deps.client.updateEntry(token, {
          vaultId: metadata.vaultId,
          entryId: metadata.id,
          baseRevision: detail.currentRevision,
          newEntryKey: material.entryKey,
          memberSecret: material.memberSecret,
          memberIndex: material.memberIndex,
          agentDiscoveryChanged: discoveryChanged,
          agentDiscovery: discoveryChanged ? material.agentDiscovery : null,
          grantEnvelopes: [],
        }))
      } catch (error) {
        if (error instanceof Protocol2MutationConflictError) {
          return { status: 'blocked', reason: 'grant-refresh-required' }
        }
        throw error
      }
      await this.refreshAfterCommittedMutation()
      return { status: 'updated' }
    } finally {
      if (discoveryKey !== null) wipe(discoveryKey)
      if (vaultKey !== null) wipe(vaultKey)
    }
  }

  private async refreshAfterCommittedMutation(): Promise<void> {
    try {
      await this.refresh()
    } catch {
      // The server mutation is already committed. Keep the successful result so the
      // caller cannot accidentally retry it; the next scheduled/manual refresh heals
      // the local projection.
    }
  }

  private async syncVault(userId: string, vault: EncryptedVaultSummary): Promise<void> {
    const active = await this.deps.cache.getActiveState(userId, vault.id)
    if (active !== null) {
      try {
        let expected = active.appliedThroughSequence
        let continuation: string | null = null
        do {
          const page = await this.withAuth((token) =>
            this.deps.client.delta(token, vault.id, continuation === null ? expected : null, continuation))
          await this.deps.cache.applyActiveDeltaPage(userId, vault, expected, page)
          expected = page.appliedThroughSequence
          continuation = page.continuationCursor
        } while (continuation !== null)
        return
      } catch (error) {
        if (!(error instanceof Protocol2ResetRequiredError)) throw error
      }
    }
    await this.replaceFromSnapshot(userId, vault)
  }

  private async replaceFromSnapshot(userId: string, vault: EncryptedVaultSummary): Promise<void> {
    const namespace = this.createNamespace()
    let cursor: string | null = null
    let baseSequence: string | null = null
    do {
      const page = await this.withAuth((token) => this.deps.client.snapshot(token, vault.id, cursor))
      if (baseSequence === null) {
        baseSequence = page.snapshotBaseSequence
        await this.deps.cache.beginSnapshot(userId, vault, namespace, baseSequence)
      } else if (page.snapshotBaseSequence !== baseSequence) {
        throw new VaultDataError('network', 'Vault snapshot base changed')
      }
      await this.deps.cache.applySnapshotPage(userId, vault.id, namespace, page.items, page.nextCursor)
      cursor = page.nextCursor
    } while (cursor !== null)

    if (baseSequence === null) throw new VaultDataError('network', 'Vault snapshot was empty')
    let expected = baseSequence
    let continuation: string | null = null
    do {
      const page = await this.withAuth((token) =>
        this.deps.client.delta(token, vault.id, continuation === null ? expected : null, continuation))
      await this.deps.cache.applyPendingDeltaPage(userId, vault.id, namespace, expected, page)
      expected = page.appliedThroughSequence
      continuation = page.continuationCursor
    } while (continuation !== null)
    const latest = await this.withAuth((token) => this.deps.client.getVault(token, vault.id))
    await this.deps.cache.completeSnapshot(userId, latest, namespace, expected)
    this.currentVaults.set(vault.id, latest)
  }

  private async requireVault(vaultId: string): Promise<EncryptedVaultSummary> {
    const cached = this.currentVaults.get(vaultId)
    if (cached !== undefined) return cached
    const vault = await this.withAuth((token) => this.deps.client.getVault(token, vaultId))
    this.currentVaults.set(vaultId, vault)
    return vault
  }

  private async withAuth<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const token = await this.deps.session.getAccessToken()
    if (token === null) throw new VaultDataError('not-authenticated', 'No session')
    try {
      return await operation(token)
    } catch (error) {
      if (error instanceof VaultClientError && error.code === 'unauthorized') {
        const refreshed = await this.deps.session.refreshAccessToken()
        if (refreshed === null) throw new VaultDataError('not-authenticated', 'Session expired')
        try {
          return await operation(refreshed)
        } catch (retryError) {
          if (retryError instanceof Protocol2ResetRequiredError
            || retryError instanceof Protocol2MutationConflictError) throw retryError
          throw mapTransportError(retryError)
        }
      }
      if (error instanceof Protocol2ResetRequiredError
        || error instanceof Protocol2MutationConflictError) throw error
      throw mapTransportError(error)
    }
  }
}

function credentialSecret(site: string, origin: string, password: string): MemberSecretV1 {
  return {
    schema: 'palladin.member-secret.v1',
    entryType: 'credential',
    memberLabel: site,
    agentLabel: null,
    discoverable: false,
    description: null,
    icon: null,
    color: null,
    agentFieldAccess: {
      memberLabel: 'never',
      agentLabel: 'never',
      description: 'never',
      icon: 'never',
      color: 'never',
      entryType: 'never',
      'credential.username': 'never',
      'credential.password': 'never',
      'credential.url': 'never',
      'credential.urlDomain': 'never',
      'credential.totp': 'never',
      notes: 'never',
    },
    content: {
      username: '',
      password,
      url: origin,
      urlDomain: site,
      totp: null,
      notes: null,
      customFields: [],
    },
  }
}

function creditCardSecret(input: CreditCardSaveInput): MemberSecretV1 {
  return {
    schema: 'palladin.member-secret.v1',
    entryType: 'creditCard',
    memberLabel: input.label.trim(),
    agentLabel: null,
    discoverable: false,
    description: null,
    icon: null,
    color: null,
    agentFieldAccess: {
      memberLabel: 'never',
      agentLabel: 'never',
      description: 'never',
      icon: 'never',
      color: 'never',
      entryType: 'never',
      'creditCard.cardholderName': 'never',
      'creditCard.cardNumber': 'never',
      'creditCard.expiryMonth': 'never',
      'creditCard.expiryYear': 'never',
      'creditCard.billingAddress': 'never',
      notes: 'never',
    },
    content: {
      cardholderName: input.cardholderName.trim(),
      cardNumber: input.cardNumber,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      billingAddress: input.billingAddress?.trim() || null,
      notes: input.notes?.trim() || null,
      customFields: [],
    },
  }
}

function entryTypeCode(entryType: MemberSecretV1['entryType']): EntryTypeCode {
  if (entryType === 'key') return ENTRY_TYPE_KEY
  if (entryType === 'script') return ENTRY_TYPE_SCRIPT
  if (entryType === 'creditCard') return ENTRY_TYPE_CREDIT_CARD
  return ENTRY_TYPE_CREDENTIAL
}

function parseSecureSite(url: string): { origin: string; site: string } | null {
  try {
    const parsed = new URL(url)
    const site = registrableDomain(url)
    return parsed.protocol === 'https:' && site !== null ? { origin: parsed.origin, site } : null
  } catch {
    return null
  }
}

function mapTransportError(error: unknown): VaultDataError {
  if (error instanceof VaultDataError) return error
  if (error instanceof VaultClientError) {
    return error.code === 'unauthorized'
      ? new VaultDataError('not-authenticated', 'Session expired')
      : new VaultDataError('network', 'Vault request failed')
  }
  return new VaultDataError('network', 'Vault request failed')
}
