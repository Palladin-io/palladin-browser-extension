import {
  openMemberIndex,
  openMemberSecret,
  openVaultProjection,
  openVaultDerivedEnvelope,
  presentationIconReference,
  projectAgentDiscovery,
  sealCanonicalEntry,
  wipe,
  type AgentFieldAccess,
  type MemberSecretV1,
  type ScriptInterpreter,
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
import type { ActiveCacheState, MemberSyncCache } from './cache'
import {
  Protocol2MutationConflictError,
  Protocol2ResetRequiredError,
  type Protocol2VaultClient,
} from './client'
import type { EncryptedVaultListSummary, EncryptedVaultSummary } from './contracts'

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
  readonly customFields?: readonly ManualCustomFieldInput[]
}

export type ManualCustomFieldType = 'text' | 'multiline' | 'concealed'

export interface ManualCustomFieldInput {
  readonly id: string
  readonly label: string
  readonly type: ManualCustomFieldType
  readonly value: string
}

export type ManualEntrySaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'blocked'; readonly reason: 'grant-refresh-required' }

export type ManualEntrySaveInput =
  | {
      readonly entryType: 'credential'
      readonly label: string
      readonly username: string
      readonly password: string
      readonly url?: string
      readonly notes?: string
      readonly customFields?: readonly ManualCustomFieldInput[]
    }
  | {
      readonly entryType: 'key'
      readonly label: string
      readonly value: string
      readonly notes?: string
      readonly customFields?: readonly ManualCustomFieldInput[]
    }
  | {
      readonly entryType: 'script'
      readonly label: string
      readonly source: string
      readonly interpreter: ScriptInterpreter
      readonly notes?: string
      readonly customFields?: readonly ManualCustomFieldInput[]
    }
  | ({ readonly entryType: 'creditCard' } & CreditCardSaveInput)

export interface Protocol2VaultDataServiceDeps {
  readonly client: Protocol2VaultClient
  readonly cache: MemberSyncCache
  readonly session: Protocol2SessionAccessor
  readonly createNamespace?: () => string
  readonly now?: () => number
}

/** Canonical Vault Protocol 2 sync/read/write service for the MV3 worker. */
export class Protocol2VaultDataService implements VaultDataSource {
  private readonly currentVaults = new Map<string, EncryptedVaultSummary>()
  private readonly createNamespace: () => string
  private readonly now: () => number
  private lastUserId: string | null = null
  private refreshInFlight: Promise<EntryMetadata[]> | null = null
  private lastSuccessfulRefreshAt: number | null = null
  private syncTail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: Protocol2VaultDataServiceDeps) {
    this.createNamespace = deps.createNamespace ?? (() => crypto.randomUUID())
    this.now = deps.now ?? (() => Date.now())
  }

  async refresh(): Promise<EntryMetadata[]> {
    // Unlock triggers a background refresh while an already-open popup can
    // request its own sync at the same time. Both consumers must join one
    // canonical refresh: parallel writers would race the IndexedDB snapshot /
    // delta cursor and surface a misleading network failure.
    if (this.refreshInFlight !== null) return this.refreshInFlight
    const refresh = this.enqueueSync(() => this.refreshOnce())
    this.refreshInFlight = refresh
    try {
      const metadata = await refresh
      this.lastSuccessfulRefreshAt = this.now()
      return metadata
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null
    }
  }

  async refreshIfStale(maxAgeMs: number): Promise<EntryMetadata[]> {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
      throw new TypeError('Vault refresh max age must be a non-negative safe integer')
    }
    const refreshedAt = this.lastSuccessfulRefreshAt
    if (refreshedAt !== null && this.now() - refreshedAt < maxAgeMs) {
      return this.getMetadata()
    }
    return this.refresh()
  }

  async applyRealtimeInvalidation(vaultId: string, removed: boolean): Promise<void> {
    await this.enqueueSync(async () => {
      const userId = await this.deps.session.getUserId()
      if (userId === null || await this.deps.session.getAccessToken() === null) {
        throw new VaultDataError('not-authenticated', 'No session')
      }
      this.lastUserId = userId
      if (removed) {
        this.currentVaults.delete(vaultId)
        await this.deps.cache.removeVault(userId, vaultId)
        return
      }
      const vault = await this.withAuth((token) => this.deps.client.getVault(token, vaultId))
      await this.syncVault(userId, vault)
      const refreshed = await this.deps.cache.getActiveState(userId, vault.id)
      this.currentVaults.set(vault.id, refreshed?.vault ?? vault)
    })
  }

  private async refreshOnce(): Promise<EntryMetadata[]> {
    const userId = await this.deps.session.getUserId()
    if (userId === null || await this.deps.session.getAccessToken() === null) {
      await this.clearCache()
      return []
    }

    const listedVaults = await this.withAuth((token) => this.deps.client.listVaults(token))
    this.lastUserId = userId
    this.currentVaults.clear()
    const detailedVaults: EncryptedVaultSummary[] = []
    for (const listedVault of listedVaults) {
      const active = await this.deps.cache.getActiveState(userId, listedVault.id)
      if (active !== null && matchesVaultChangeManifest(listedVault, active)) {
        detailedVaults.push(active.vault)
        this.currentVaults.set(listedVault.id, active.vault)
        continue
      }
      const vault = await this.withAuth((token) => this.deps.client.getVault(token, listedVault.id))
      detailedVaults.push(vault)
      await this.syncVault(userId, vault)
      const refreshed = await this.deps.cache.getActiveState(userId, vault.id)
      this.currentVaults.set(vault.id, refreshed?.vault ?? vault)
    }
    await this.deps.cache.removeMissingVaults(userId, new Set(listedVaults.map((vault) => vault.id)))
    try {
      return await this.getMetadata()
    } catch (error) {
      if (!(error instanceof VaultDataError) || error.code !== 'decrypt-failed') throw error

      // IndexedDB stores disposable ciphertext only. A browser update can leave
      // an old but structurally valid projection behind; an empty delta then
      // cannot heal that cached envelope. Rebuild it exactly once from an
      // authoritative snapshot. If the server ciphertext itself is invalid,
      // the second decrypt still fails closed and is surfaced to the caller.
      await this.deps.cache.removeMissingVaults(userId, new Set())
      this.currentVaults.clear()
      for (const vault of detailedVaults) {
        await this.replaceFromSnapshot(userId, vault)
      }
      return this.getMetadata()
    }
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
        let vaultName: string
        try {
          const opened = await openProjectionVault(active.vault, privateKey, userId)
          vaultKey = opened.vaultKey
          vaultName = opened.metadata.name
        } catch {
          throw new VaultDataError('decrypt-failed', 'vault-projection')
        }
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
            let index: Awaited<ReturnType<typeof openMemberIndex>>
            try {
              index = await openMemberIndex(item.entryKey, item.memberIndex, vaultKey, {
                organizationId: active.vault.memberVaultKey.wrappedVaultKey.descriptor.scope.organizationId,
                vaultId,
                entryId: item.entryId,
                revision: item.memberIndexRevision,
              })
            } catch {
              throw new VaultDataError('decrypt-failed', 'member-index')
            }
            const icon = index.icon ? presentationIconReference(index.icon) : undefined
            metadata.push({
              id: item.entryId,
              vaultId,
              vaultName,
              name: index.memberLabel,
              type: entryTypeCode(index.entryType),
              updatedAt: item.updatedAt,
              ...(index.username !== null ? { username: index.username } : {}),
              ...(index.urlDomain ? { urlDomain: index.urlDomain } : {}),
              ...(icon ? { icon } : {}),
              ...(index.color ? { color: index.color } : {}),
            })
          }
          afterEntryId = page.nextEntryId
        } while (afterEntryId !== null)
      } catch (error) {
        if (error instanceof VaultDataError) throw error
        throw new VaultDataError('decrypt-failed', 'vault-index')
      } finally {
        if (vaultKey !== null) wipe(vaultKey)
      }
    }
    return metadata
  }

  async revealEntry(vaultId: string, entryId: string): Promise<MemberSecretV1> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const userId = await this.deps.session.getUserId()
    if (userId === null) throw new VaultDataError('not-authenticated', 'No session')
    const detail = await this.withAuth((token) => this.deps.client.getEntry(token, vaultId, entryId))
    const vault = await this.requireVault(vaultId)
    let vaultKey: Uint8Array | null = null
    try {
      vaultKey = await openProjectionVaultKey(vault, privateKey, userId)
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
    this.lastSuccessfulRefreshAt = null
  }

  async clearAllCache(): Promise<void> {
    this.currentVaults.clear()
    this.lastUserId = null
    this.lastSuccessfulRefreshAt = null
    await this.deps.cache.clearAll()
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
        return this.updateCredential(matches[0]!, input.password, input.url)
      }
    }
    return this.createCredential(input.site, parsed.origin, parsed.host, input.password)
  }

  async saveEntry(input: ManualEntrySaveInput): Promise<ManualEntrySaveResult> {
    if (this.currentVaults.size === 0) await this.refresh()
    let secret: MemberSecretV1
    switch (input.entryType) {
      case 'credential':
        secret = manualCredentialSecret(input)
        break
      case 'key':
        secret = keySecret(input)
        break
      case 'script':
        secret = scriptSecret(input)
        break
      case 'creditCard': {
        const cardNumber = input.cardNumber.replace(/[ -]/g, '')
        if (!/^[0-9]{8,19}$/.test(cardNumber)) {
          throw new VaultDataError('network', 'Card number is invalid')
        }
        secret = creditCardSecret({ ...input, cardNumber })
        break
      }
    }
    const result = await this.createCanonicalEntry(secret)
    return result.status === 'created'
      ? { status: 'saved' }
      : { status: 'blocked', reason: 'grant-refresh-required' }
  }

  private async createCredential(
    site: string,
    origin: string,
    host: string,
    password: string,
  ): Promise<GeneratedPasswordSaveResult> {
    return this.createCanonicalEntry(credentialSecret(site, origin, host, password))
  }

  private async createCanonicalEntry(
    secret: MemberSecretV1,
  ): Promise<Extract<GeneratedPasswordSaveResult, { status: 'created' | 'blocked' }>> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const userId = await this.deps.session.getUserId()
    if (userId === null) throw new VaultDataError('not-authenticated', 'No session')
    const vault = [...this.currentVaults.values()].find((candidate) => candidate.isDefault)
      ?? [...this.currentVaults.values()][0]
    if (vault === undefined) throw new VaultDataError('network', 'No Vault is available')
    const entryId = await this.withAuth((token) =>
      this.deps.client.issueEntryCreationChallenge(token, vault.id))
    let vaultKey: Uint8Array | null = null
    let discoveryKey: Uint8Array | null = null
    try {
      vaultKey = await openProjectionVaultKey(vault, privateKey, userId)
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
    captureUrl: string,
  ): Promise<GeneratedPasswordSaveResult> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const userId = await this.deps.session.getUserId()
    if (userId === null) throw new VaultDataError('not-authenticated', 'No session')
    const [vault, detail] = await Promise.all([
      this.requireVault(metadata.vaultId),
      this.withAuth((token) => this.deps.client.getEntry(token, metadata.vaultId, metadata.id)),
    ])
    let vaultKey: Uint8Array | null = null
    let discoveryKey: Uint8Array | null = null
    try {
      vaultKey = await openProjectionVaultKey(vault, privateKey, userId)
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
      if (!matchesTab(captureUrl, previous.content.urlDomain)) {
        return { status: 'blocked', reason: 'ambiguous-target' }
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

  private enqueueSync<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.syncTail.then(operation, operation)
    this.syncTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function matchesVaultChangeManifest(
  listed: EncryptedVaultListSummary,
  active: ActiveCacheState,
): boolean {
  if (active.appliedThroughSequence !== listed.memberSequence) return false
  if (active.vault.metadataRevision
    !== listed.memberVaultMetadata.descriptor.resourceRevision) return false
  if (active.vault.organizationId
    !== listed.memberVaultMetadata.descriptor.scope.organizationId) return false
  return JSON.stringify(vaultChangeManifest(active.vault))
    === JSON.stringify(vaultChangeManifest(listed))
}

function vaultChangeManifest(vault: EncryptedVaultListSummary | EncryptedVaultSummary) {
  return [
    vault.id,
    vault.isDefault,
    vault.protocolVersion,
    vault.memberSequence,
    vault.discoverySequence,
    vault.memberKeyGeneration,
    vault.currentKeyEpoch,
    vault.memberVaultMetadata,
    vault.memberVaultKey,
    vault.discoveryKey,
    vault.vaultPrivateKeys,
    vault.createdAt,
    vault.updatedAt,
    vault.memberCount,
    vault.entryCount,
    vault.activeGrantCount,
  ]
}

async function openProjectionVaultKey(
  vault: EncryptedVaultSummary,
  privateKey: Uint8Array,
  memberId: string,
): Promise<Uint8Array> {
  return (await openProjectionVault(vault, privateKey, memberId)).vaultKey
}

async function openProjectionVault(
  vault: EncryptedVaultSummary,
  privateKey: Uint8Array,
  memberId: string,
) {
  return openVaultProjection({
    id: vault.id,
    organizationId: vault.organizationId,
    metadataRevision: vault.metadataRevision,
    memberKeyGeneration: vault.memberKeyGeneration,
    currentKeyEpoch: vault.currentKeyEpoch,
    memberVaultMetadata: vault.memberVaultMetadata,
    memberVaultKey: vault.memberVaultKey,
  }, privateKey, memberId)
}

function credentialSecret(site: string, origin: string, host: string, password: string): MemberSecretV1 {
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
      urlDomain: host,
      totp: null,
      notes: null,
      customFields: [],
    },
  }
}

function commonSecret(label: string): Pick<MemberSecretV1,
  'schema' | 'memberLabel' | 'agentLabel' | 'discoverable' | 'description' | 'icon' | 'color'> {
  return {
    schema: 'palladin.member-secret.v1',
    memberLabel: label.trim(),
    agentLabel: null,
    discoverable: false,
    description: null,
    icon: null,
    color: null,
  }
}

function manualCredentialSecret(
  input: Extract<ManualEntrySaveInput, { entryType: 'credential' }>,
): MemberSecretV1 {
  const url = input.url?.trim() || null
  let urlDomain: string | null = null
  if (url !== null) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHostname(parsed.hostname))) {
        throw new Error('unsupported credential URL')
      }
      urlDomain = parsed.hostname.toLowerCase().replace(/\.$/, '')
    } catch {
      throw new VaultDataError('network', 'Credential URL is invalid')
    }
  }
  const customFields = manualCustomFields(input.customFields)
  return {
    ...commonSecret(input.label),
    entryType: 'credential',
    agentFieldAccess: customFieldAccess({
      memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never',
      entryType: 'never', 'credential.username': 'never', 'credential.password': 'never',
      'credential.url': 'never', 'credential.urlDomain': 'never', 'credential.totp': 'never', notes: 'never',
    }, customFields),
    content: {
      username: input.username.trim(),
      password: input.password,
      url,
      urlDomain,
      totp: null,
      notes: input.notes?.trim() || null,
      customFields,
    },
  }
}

function keySecret(input: Extract<ManualEntrySaveInput, { entryType: 'key' }>): MemberSecretV1 {
  const customFields = manualCustomFields(input.customFields)
  return {
    ...commonSecret(input.label),
    entryType: 'key',
    agentFieldAccess: customFieldAccess({
      memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never',
      entryType: 'never', 'key.value': 'never', notes: 'never',
    }, customFields),
    content: { value: input.value, notes: input.notes?.trim() || null, customFields },
  }
}

function scriptSecret(input: Extract<ManualEntrySaveInput, { entryType: 'script' }>): MemberSecretV1 {
  const customFields = manualCustomFields(input.customFields)
  return {
    ...commonSecret(input.label),
    entryType: 'script',
    agentFieldAccess: customFieldAccess({
      memberLabel: 'never', agentLabel: 'never', description: 'never', icon: 'never', color: 'never',
      entryType: 'never', 'script.source': 'never', 'script.interpreter': 'never',
      'script.refs': 'never', notes: 'never',
    }, customFields),
    content: {
      source: input.source,
      interpreter: input.interpreter,
      refs: [],
      notes: input.notes?.trim() || null,
      customFields,
    },
  }
}

function creditCardSecret(input: CreditCardSaveInput): MemberSecretV1 {
  const customFields = manualCustomFields(input.customFields)
  return {
    schema: 'palladin.member-secret.v1',
    entryType: 'creditCard',
    memberLabel: input.label.trim(),
    agentLabel: null,
    discoverable: false,
    description: null,
    icon: null,
    color: null,
    agentFieldAccess: customFieldAccess({
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
    }, customFields),
    content: {
      cardholderName: input.cardholderName.trim(),
      cardNumber: input.cardNumber,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
      billingAddress: input.billingAddress?.trim() || null,
      notes: input.notes?.trim() || null,
      customFields,
    },
  }
}

function manualCustomFields(fields: readonly ManualCustomFieldInput[] | undefined) {
  return (fields ?? []).map((field) => ({
    id: field.id,
    label: field.label.trim().normalize('NFC'),
    type: field.type,
    value: field.value,
  }))
}

function customFieldAccess(
  builtIn: Record<string, AgentFieldAccess>,
  fields: readonly { readonly id: string }[],
): Record<string, AgentFieldAccess> {
  const access = { ...builtIn }
  for (const field of fields) access[field.id] = 'never'
  return access
}

function entryTypeCode(entryType: MemberSecretV1['entryType']): EntryTypeCode {
  if (entryType === 'key') return ENTRY_TYPE_KEY
  if (entryType === 'script') return ENTRY_TYPE_SCRIPT
  if (entryType === 'creditCard') return ENTRY_TYPE_CREDIT_CARD
  return ENTRY_TYPE_CREDENTIAL
}

function parseSecureSite(url: string): { origin: string; site: string; host: string } | null {
  try {
    const parsed = new URL(url)
    const site = registrableDomain(url)
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return parsed.protocol === 'https:' && site !== null ? { origin: parsed.origin, site, host } : null
  } catch {
    return null
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
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
