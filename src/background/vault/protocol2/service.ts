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
import type {
  ActiveCachedEntry,
  ActiveCacheState,
  CachedItemPage,
  MemberSyncCache,
} from './cache'
import { MAXIMUM_PROFILE_CACHE_BYTES } from './cache'
import {
  Protocol2AccessDeniedError,
  Protocol2MutationConflictError,
  Protocol2ResetRequiredError,
  type Protocol2VaultClient,
} from './client'
import type {
  EncryptedVaultListSummary,
  EncryptedVaultSummary,
  MemberDeltaPage,
  MemberSnapshotPage,
  MemberSyncItem,
  MemberVaultKeyEnvelope,
  OfflineAccessContext,
} from './contracts'

const CACHE_PAGE_SIZE = 200
const MAXIMUM_CLOCK_ROLLBACK_MS = 5 * 60_000

interface VolatileDisabledVault {
  active: ActiveCacheState
  items: Map<string, MemberSyncItem>
  encodedItemBytes: number
}

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
  readonly monotonicNow?: () => number
}

/** Canonical Vault Protocol 2 sync/read/write service for the MV3 worker. */
export class Protocol2VaultDataService implements VaultDataSource {
  private readonly currentVaults = new Map<string, EncryptedVaultSummary>()
  private readonly createNamespace: () => string
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private lastUserId: string | null = null
  private refreshInFlight: Promise<EntryMetadata[]> | null = null
  private refreshInFlightIsRepair = false
  private lastSuccessfulRefreshAt: number | null = null
  private syncTail: Promise<void> = Promise.resolve()
  private readonly leaseDeadlines = new Map<string, { signature: string; deadline: number }>()
  private readonly volatileDisabledVaults = new Map<string, VolatileDisabledVault>()
  private connected = false

  constructor(private readonly deps: Protocol2VaultDataServiceDeps) {
    this.createNamespace = deps.createNamespace ?? (() => crypto.randomUUID())
    this.now = deps.now ?? (() => Date.now())
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now())
  }

  async refresh(): Promise<EntryMetadata[]> {
    if (this.refreshInFlight !== null) return this.refreshInFlight
    return this.startRefresh(false)
  }

  async repair(): Promise<EntryMetadata[]> {
    const current = this.refreshInFlight
    if (current !== null) {
      if (this.refreshInFlightIsRepair) return current
      await current.catch(() => undefined)
    }
    if (this.refreshInFlight !== null) return this.repair()
    return this.startRefresh(true)
  }

  private async startRefresh(forceRepair: boolean): Promise<EntryMetadata[]> {
    const refresh = this.enqueueSync(() => this.refreshOnce(forceRepair))
    this.refreshInFlight = refresh
    this.refreshInFlightIsRepair = forceRepair
    try {
      const metadata = await refresh
      this.lastSuccessfulRefreshAt = this.now()
      return metadata
    } finally {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = null
        this.refreshInFlightIsRepair = false
      }
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
        await this.purgeVault(userId, vaultId)
        return
      }
      try {
        const vault = await this.withAuth((token) => this.deps.client.getVault(token, vaultId))
        await this.syncVault(userId, vault)
        const refreshed = await this.deps.cache.getActiveState(userId, vault.id)
          ?? this.volatileDisabledVaults.get(vault.id)?.active
        this.currentVaults.set(vault.id, refreshed?.vault ?? vault)
      } catch (error) {
        if (!(error instanceof Protocol2AccessDeniedError)) throw error
        await this.purgeVault(userId, vaultId)
      }
    })
  }

  setRealtimeConnected(connected: boolean): void {
    this.connected = connected
    if (!connected) {
      for (const vaultId of this.volatileDisabledVaults.keys()) {
        this.currentVaults.delete(vaultId)
      }
      this.volatileDisabledVaults.clear()
    }
  }

  private async refreshOnce(forceRepair: boolean): Promise<EntryMetadata[]> {
    const userId = await this.deps.session.getUserId()
    if (userId === null || await this.deps.session.getAccessToken() === null) {
      this.currentVaults.clear()
      this.volatileDisabledVaults.clear()
      this.connected = false
      return []
    }

    const listedVaults = await this.withAuth((token) => this.deps.client.listVaults(token))
    this.connected = true
    this.lastUserId = userId
    this.currentVaults.clear()
    const detailedVaults: EncryptedVaultSummary[] = []
    for (const listedVault of listedVaults) {
      const active = await this.deps.cache.getActiveState(userId, listedVault.id)
        ?? this.volatileDisabledVaults.get(listedVault.id)?.active
        ?? null
      const unchanged = active !== null && matchesVaultChangeManifest(listedVault, active)
      if (unchanged && !forceRepair && !leaseNeedsRenewal(active, this.now())) {
        detailedVaults.push(active.vault)
        this.currentVaults.set(listedVault.id, active.vault)
        continue
      }
      try {
        const vault = unchanged
          ? active.vault
          : await this.withAuth((token) => this.deps.client.getVault(token, listedVault.id))
        await this.syncVault(userId, vault)
        const refreshed = await this.deps.cache.getActiveState(userId, vault.id)
          ?? this.volatileDisabledVaults.get(vault.id)?.active
        const current = refreshed?.vault ?? vault
        detailedVaults.push(current)
        this.currentVaults.set(vault.id, current)
      } catch (error) {
        if (!(error instanceof Protocol2AccessDeniedError)) throw error
        await this.purgeVault(userId, listedVault.id)
      }
    }
    await this.deps.cache.removeMissingVaults(userId, new Set(listedVaults.map((vault) => vault.id)))
    const retainedVaultIds = new Set(listedVaults.map((vault) => vault.id))
    for (const vaultId of this.volatileDisabledVaults.keys()) {
      if (!retainedVaultIds.has(vaultId)) this.volatileDisabledVaults.delete(vaultId)
    }
    try {
      return await this.getMetadataNow()
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
      return this.getMetadataNow()
    }
  }

  getMetadata(): Promise<EntryMetadata[]> {
    return this.enqueueSync(() => this.getMetadataNow())
  }

  private async getMetadataNow(): Promise<EntryMetadata[]> {
    const userId = await this.deps.session.getUserId()
    const privateKey = this.deps.session.getPrivateKey()
    if (userId === null || privateKey === null) return []

    const metadata: EntryMetadata[] = []
    const activeStates = await this.deps.cache.listActiveStates(userId)
    if (this.connected) {
      activeStates.push(...[...this.volatileDisabledVaults.values()].map((value) => value.active))
    }
    for (const initialActive of activeStates) {
      const vaultId = initialActive.vault.id
      let vaultKey: Uint8Array | null = null
      try {
        this.validateActiveState(initialActive, userId, this.now())
        this.currentVaults.set(vaultId, initialActive.vault)
        let vaultName: string
        try {
          const opened = await openProjectionVault({
            ...initialActive.vault,
            memberVaultKey: initialActive.memberVaultKey,
          }, privateKey, userId)
          vaultKey = opened.vaultKey
          vaultName = opened.metadata.name
        } catch {
          throw new VaultDataError('decrypt-failed', 'vault-projection')
        }
        let afterEntryId: string | null = null
        do {
          const volatile = this.volatileDisabledVaults.get(vaultId)
          const page: CachedItemPage | null = volatile?.active.namespace === initialActive.namespace
            ? volatilePage(volatile, afterEntryId, CACHE_PAGE_SIZE, this.now())
            : await this.deps.cache.readActiveItemPage(
              userId,
              vaultId,
              afterEntryId,
              CACHE_PAGE_SIZE,
              this.now(),
            )
          if (page === null) throw new VaultDataError('decrypt-failed', 'Vault cache changed')
          this.validateActiveState(page.active, userId, this.now())
          for (const item of page.items) {
            if (item.kind !== 'head' || item.state !== 'active') continue
            validateCompleteItem(item, page.active)
            let index: Awaited<ReturnType<typeof openMemberIndex>>
            try {
              index = await openMemberIndex(item.entryKey, item.memberIndex, vaultKey, {
                organizationId: page.active.accessContext.organizationId,
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
        await this.purgeVault(userId, vaultId)
        if (error instanceof VaultDataError) throw error
        throw new VaultDataError('decrypt-failed', 'vault-index')
      } finally {
        if (vaultKey !== null) wipe(vaultKey)
      }
    }
    return metadata
  }

  revealEntry(vaultId: string, entryId: string): Promise<MemberSecretV1> {
    return this.enqueueSync(() => this.revealEntryNow(vaultId, entryId))
  }

  private async revealEntryNow(vaultId: string, entryId: string): Promise<MemberSecretV1> {
    const privateKey = this.deps.session.getPrivateKey()
    if (privateKey === null) throw new VaultDataError('locked', 'Session is locked')
    const userId = await this.deps.session.getUserId()
    if (userId === null) throw new VaultDataError('not-authenticated', 'No session')
    const persistent = await this.deps.cache.readActiveEntry(userId, vaultId, entryId, this.now())
    const volatile = this.volatileDisabledVaults.get(vaultId)
    const cached = persistent ?? (this.connected && volatile?.items.has(entryId)
      ? volatileEntry(volatile, entryId, this.now())
      : null)
    if (cached === null || cached.item.kind !== 'head' || cached.item.state !== 'active') {
      throw new VaultDataError('decrypt-failed', 'Current entry is unavailable')
    }
    let vaultKey: Uint8Array | null = null
    try {
      this.validateActiveState(cached.active, userId, this.now())
      validateCompleteItem(cached.item, cached.active)
      vaultKey = await openProjectionVaultKey({
        ...cached.active.vault,
        memberVaultKey: cached.active.memberVaultKey,
      }, privateKey, userId)
      return await openMemberSecret(cached.item.entryKey, cached.item.memberSecret, vaultKey, {
        organizationId: cached.active.accessContext.organizationId,
        vaultId,
        entryId,
        revision: cached.item.currentRevision,
      })
    } catch (error) {
      await this.purgeVault(userId, vaultId)
      if (error instanceof VaultDataError) throw error
      throw new VaultDataError('decrypt-failed', 'Failed to decrypt entry')
    } finally {
      if (vaultKey !== null) wipe(vaultKey)
    }
  }

  async clearCache(): Promise<void> {
    const userId = this.lastUserId ?? await this.deps.session.getUserId()
    this.currentVaults.clear()
    this.volatileDisabledVaults.clear()
    this.connected = false
    if (userId !== null) await this.deps.cache.removeProfile(userId)
    this.lastUserId = null
    this.lastSuccessfulRefreshAt = null
    this.leaseDeadlines.clear()
  }

  async clearProfile(userId: string): Promise<void> {
    await this.enqueueSync(async () => {
      await this.deps.cache.removeProfile(userId)
      this.currentVaults.clear()
      this.volatileDisabledVaults.clear()
      this.connected = false
      this.leaseDeadlines.clear()
      if (this.lastUserId === userId) this.lastUserId = null
      this.lastSuccessfulRefreshAt = null
    })
  }

  async clearAllCache(): Promise<void> {
    this.currentVaults.clear()
    this.volatileDisabledVaults.clear()
    this.connected = false
    this.lastUserId = null
    this.lastSuccessfulRefreshAt = null
    this.leaseDeadlines.clear()
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
          deliveryPolicy: 'standard',
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
          deliveryPolicy: 'standard',
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
    const persistent = await this.deps.cache.getActiveState(userId, vault.id)
    const volatile = this.volatileDisabledVaults.get(vault.id)
    const active = persistent ?? volatile?.active ?? null
    if (active !== null) {
      try {
        let expected = active.appliedThroughSequence
        let upperBound: string | null = null
        let continuation: string | null = null
        do {
          const page = await this.withAuth((token) =>
            this.deps.client.delta(token, vault.id, continuation === null ? expected : null, continuation))
          validateDeltaPage(page, vault, userId, expected, upperBound)
          if ((persistent !== null) !== (page.accessContext.offlinePolicy !== 'disabled')) {
            await this.purgeVault(userId, vault.id)
            return this.replaceFromSnapshot(userId, vault)
          }
          upperBound ??= page.deltaUpperBound
          if (persistent !== null) {
            await this.deps.cache.applyActiveDeltaPage(userId, vault, expected, page, this.now())
          } else if (volatile !== undefined) {
            const nextItems = new Map(volatile.items)
            const nextItemBytes = applyVolatileItems(
              nextItems,
              page.items,
              volatile.encodedItemBytes,
            )
            const nextActive: ActiveCacheState = {
              ...volatile.active,
              appliedThroughSequence: page.appliedThroughSequence,
              vault: { ...vault, memberSequence: page.appliedThroughSequence },
              accessContext: page.accessContext,
              memberVaultKey: page.memberVaultKey,
              maxObservedWallTime: Math.max(volatile.active.maxObservedWallTime, this.now()),
            }
            await this.assertVolatileProfileQuota(userId, vault.id, nextActive, nextItemBytes)
            volatile.items = nextItems
            volatile.encodedItemBytes = nextItemBytes
            volatile.active = nextActive
          }
          expected = page.appliedThroughSequence
          continuation = page.continuationCursor
        } while (continuation !== null)
        if (volatile !== undefined) this.currentVaults.set(vault.id, volatile.active.vault)
        return
      } catch (error) {
        if (!(error instanceof Protocol2ResetRequiredError)) throw error
        await this.purgeVault(userId, vault.id)
      }
    }
    await this.replaceFromSnapshot(userId, vault)
  }

  private async replaceFromSnapshot(userId: string, vault: EncryptedVaultSummary): Promise<void> {
    const namespace = this.createNamespace()
    const firstPage = await this.withAuth((token) => this.deps.client.snapshot(token, vault.id, null))
    validateSnapshotPage(firstPage, vault, userId, null, null)
    if (firstPage.accessContext.offlinePolicy === 'disabled') {
      await this.purgeVault(userId, vault.id)
      return this.replaceVolatileFromSnapshot(userId, vault, namespace, firstPage)
    }

    const baseSequence = firstPage.snapshotBaseSequence
    const authoritativeAccess = firstPage.accessContext
    const authoritativeMemberVaultKey = firstPage.memberVaultKey
    await this.deps.cache.beginSnapshot(
      userId,
      vault,
      namespace,
      baseSequence,
      authoritativeAccess,
      authoritativeMemberVaultKey,
      this.now(),
    )
    let page = firstPage
    while (true) {
      if (page.accessContext.offlinePolicy === 'disabled') {
        await this.purgeVault(userId, vault.id)
        throw new VaultDataError('decrypt-failed', 'Offline policy changed during snapshot')
      }
      validateSnapshotPage(page, vault, userId, authoritativeAccess, authoritativeMemberVaultKey)
      if (page.snapshotBaseSequence !== baseSequence) {
        throw new VaultDataError('network', 'Vault snapshot base changed')
      }
      await this.deps.cache.applySnapshotPage(
        userId,
        vault.id,
        namespace,
        page.items,
        page.nextCursor,
        page.accessContext,
        page.memberVaultKey,
        this.now(),
      )
      if (page.nextCursor === null) break
      page = await this.withAuth((token) => this.deps.client.snapshot(token, vault.id, page.nextCursor))
    }

    let expected = baseSequence
    let upperBound: string | null = null
    let continuation: string | null = null
    do {
      const page = await this.withAuth((token) =>
        this.deps.client.delta(token, vault.id, continuation === null ? expected : null, continuation))
      validateDeltaPage(page, vault, userId, expected, upperBound)
      if (page.accessContext.offlinePolicy === 'disabled') {
        await this.purgeVault(userId, vault.id)
        throw new VaultDataError('decrypt-failed', 'Offline policy changed during closing delta')
      }
      upperBound ??= page.deltaUpperBound
      await this.deps.cache.applyPendingDeltaPage(
        userId,
        vault.id,
        namespace,
        expected,
        page,
        this.now(),
      )
      expected = page.appliedThroughSequence
      continuation = page.continuationCursor
    } while (continuation !== null)
    const completedVault = { ...vault, memberSequence: expected }
    await this.deps.cache.completeSnapshot(userId, completedVault, namespace, expected)
    this.currentVaults.set(vault.id, completedVault)
  }

  private async replaceVolatileFromSnapshot(
    userId: string,
    vault: EncryptedVaultSummary,
    namespace: string,
    firstPage: MemberSnapshotPage,
  ): Promise<void> {
    const items = new Map<string, MemberSyncItem>()
    const baseSequence = firstPage.snapshotBaseSequence
    const authoritativeAccess = firstPage.accessContext
    const authoritativeMemberVaultKey = firstPage.memberVaultKey
    let page = firstPage
    let latestAccess = authoritativeAccess
    let latestMemberVaultKey = authoritativeMemberVaultKey
    let encodedItemBytes = 0
    while (true) {
      validateSnapshotPage(page, vault, userId, authoritativeAccess, authoritativeMemberVaultKey)
      if (page.snapshotBaseSequence !== baseSequence
        || page.accessContext.offlinePolicy !== 'disabled') {
        throw new VaultDataError('decrypt-failed', 'Disabled-policy snapshot authority changed')
      }
      encodedItemBytes = applyVolatileItems(items, page.items, encodedItemBytes)
      latestAccess = page.accessContext
      latestMemberVaultKey = page.memberVaultKey
      await this.assertVolatileProfileQuota(userId, vault.id, {
        namespace: `volatile:${namespace}`,
        appliedThroughSequence: baseSequence,
        vault: { ...vault, memberSequence: baseSequence },
        accessContext: latestAccess,
        memberVaultKey: latestMemberVaultKey,
        maxObservedWallTime: this.now(),
      }, encodedItemBytes)
      if (page.nextCursor === null) break
      page = await this.withAuth((token) => this.deps.client.snapshot(token, vault.id, page.nextCursor))
    }

    let expected = baseSequence
    let upperBound: string | null = null
    let continuation: string | null = null
    do {
      const delta = await this.withAuth((token) =>
        this.deps.client.delta(token, vault.id, continuation === null ? expected : null, continuation))
      validateDeltaPage(delta, vault, userId, expected, upperBound)
      if (delta.accessContext.offlinePolicy !== 'disabled') {
        throw new VaultDataError('decrypt-failed', 'Disabled policy changed during closing delta')
      }
      upperBound ??= delta.deltaUpperBound
      encodedItemBytes = applyVolatileItems(items, delta.items, encodedItemBytes)
      latestAccess = delta.accessContext
      latestMemberVaultKey = delta.memberVaultKey
      expected = delta.appliedThroughSequence
      continuation = delta.continuationCursor
      await this.assertVolatileProfileQuota(userId, vault.id, {
        namespace: `volatile:${namespace}`,
        appliedThroughSequence: expected,
        vault: { ...vault, memberSequence: expected },
        accessContext: latestAccess,
        memberVaultKey: latestMemberVaultKey,
        maxObservedWallTime: this.now(),
      }, encodedItemBytes)
    } while (continuation !== null)

    if (!this.connected) throw new VaultDataError('network', 'Connected access is unavailable')
    const completedVault = { ...vault, memberSequence: expected }
    this.volatileDisabledVaults.set(vault.id, {
      active: {
        namespace: `volatile:${namespace}`,
        appliedThroughSequence: expected,
        vault: completedVault,
        accessContext: latestAccess,
        memberVaultKey: latestMemberVaultKey,
        maxObservedWallTime: this.now(),
      },
      items,
      encodedItemBytes,
    })
    this.currentVaults.set(vault.id, completedVault)
  }

  private async requireVault(vaultId: string): Promise<EncryptedVaultSummary> {
    const cached = this.currentVaults.get(vaultId)
    if (cached !== undefined) return cached
    const userId = await this.deps.session.getUserId()
    if (userId !== null) {
      const active = await this.deps.cache.getActiveState(userId, vaultId)
        ?? this.volatileDisabledVaults.get(vaultId)?.active
        ?? null
      if (active !== null) {
        this.currentVaults.set(vaultId, active.vault)
        return active.vault
      }
    }
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
            || retryError instanceof Protocol2AccessDeniedError
            || retryError instanceof Protocol2MutationConflictError) throw retryError
          throw mapTransportError(retryError)
        }
      }
      if (error instanceof Protocol2ResetRequiredError
        || error instanceof Protocol2AccessDeniedError
        || error instanceof Protocol2MutationConflictError) throw error
      throw mapTransportError(error)
    }
  }

  private enqueueSync<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.syncTail.then(operation, operation)
    this.syncTail = result.then(() => undefined, () => undefined)
    return result
  }

  private validateActiveState(active: ActiveCacheState, userId: string, now: number): void {
    validateAccessAuthority(active.accessContext, active.memberVaultKey, active.vault, userId)
    if (active.accessContext.offlinePolicy === 'disabled') {
      const volatile = this.volatileDisabledVaults.get(active.vault.id)
      if (!this.connected
        || volatile?.active.namespace !== active.namespace
        || accessSignature(volatile.active.accessContext) !== accessSignature(active.accessContext)) {
        throw new VaultDataError('decrypt-failed', 'Connected access is unavailable')
      }
      volatile.active = {
        ...volatile.active,
        maxObservedWallTime: Math.max(volatile.active.maxObservedWallTime, now),
      }
      return
    }
    const lease = accessLeaseBounds(active.accessContext)
    if (BigInt(Math.trunc(now)) * 1_000_000n >= lease.notAfterNanos) {
      throw new VaultDataError('decrypt-failed', 'Offline access lease expired')
    }
    if (now + MAXIMUM_CLOCK_ROLLBACK_MS < active.maxObservedWallTime) {
      throw new VaultDataError('decrypt-failed', 'Clock rollback exceeded tolerance')
    }
    const key = `${userId}:${active.vault.id}`
    const signature = accessSignature(active.accessContext)
    const previous = this.leaseDeadlines.get(key)
    if (!previous || previous.signature !== signature) {
      this.leaseDeadlines.set(key, {
        signature,
        deadline: this.monotonicNow() + Math.max(0, lease.notAfterMs - now),
      })
      return
    }
    if (this.monotonicNow() >= previous.deadline) {
      throw new VaultDataError('decrypt-failed', 'Offline access lease expired')
    }
  }

  private async assertVolatileProfileQuota(
    userId: string,
    vaultId: string,
    candidateActive: ActiveCacheState,
    candidateItemBytes: number,
  ): Promise<void> {
    let total = await this.deps.cache.getProfileUsageBytes(userId)
      + candidateItemBytes
      + volatileStateEncodedBytes(candidateActive)
    for (const [otherVaultId, other] of this.volatileDisabledVaults) {
      if (otherVaultId === vaultId) continue
      total += other.encodedItemBytes + volatileStateEncodedBytes(other.active)
    }
    if (total > MAXIMUM_PROFILE_CACHE_BYTES) {
      throw new VaultDataError('network', 'Vault ciphertext cache quota exceeded')
    }
  }

  private async purgeVault(userId: string, vaultId: string): Promise<void> {
    this.currentVaults.delete(vaultId)
    this.volatileDisabledVaults.delete(vaultId)
    this.leaseDeadlines.delete(`${userId}:${vaultId}`)
    await this.deps.cache.removeVault(userId, vaultId)
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

function applyVolatileItems(
  target: Map<string, MemberSyncItem>,
  items: readonly MemberSyncItem[],
  currentBytes: number,
): number {
  let nextBytes = currentBytes
  for (const item of items) {
    const existing = target.get(item.entryId)
    if (existing?.kind === 'tombstone') continue
    if (item.kind === 'head' && existing?.kind === 'head'
      && BigInt(existing.currentRevision) > BigInt(item.currentRevision)) continue
    target.set(item.entryId, item)
    nextBytes += syncItemEncodedBytes(item) - (existing ? syncItemEncodedBytes(existing) : 0)
  }
  return nextBytes
}

function syncItemEncodedBytes(item: MemberSyncItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).byteLength
}

function volatileStateEncodedBytes(active: ActiveCacheState): number {
  return new TextEncoder().encode(JSON.stringify(active)).byteLength
}

function volatilePage(
  volatile: VolatileDisabledVault,
  afterEntryId: string | null,
  limit: number,
  observedWallTime: number,
): CachedItemPage {
  volatile.active = {
    ...volatile.active,
    maxObservedWallTime: Math.max(volatile.active.maxObservedWallTime, observedWallTime),
  }
  const items = [...volatile.items.values()]
    .filter((item) => afterEntryId === null || item.entryId > afterEntryId)
    .sort((left, right) => left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0)
    .slice(0, limit)
  return {
    active: volatile.active,
    items,
    nextEntryId: items.length === limit ? items.at(-1)!.entryId : null,
  }
}

function volatileEntry(
  volatile: VolatileDisabledVault,
  entryId: string,
  observedWallTime: number,
): ActiveCachedEntry {
  volatile.active = {
    ...volatile.active,
    maxObservedWallTime: Math.max(volatile.active.maxObservedWallTime, observedWallTime),
  }
  return { active: volatile.active, item: volatile.items.get(entryId)! }
}

function leaseNeedsRenewal(active: ActiveCacheState, now: number): boolean {
  try {
    const lease = accessLeaseBounds(active.accessContext)
    const duration = lease.notAfterMs - lease.issuedAtMs
    return duration <= 0 || lease.notAfterMs <= now || lease.notAfterMs - now <= duration / 4
  } catch {
    return true
  }
}

function validateSnapshotPage(
  page: MemberSnapshotPage,
  vault: EncryptedVaultSummary,
  userId: string,
  previousAccess: OfflineAccessContext | null,
  previousMemberVaultKey: MemberVaultKeyEnvelope | null,
): void {
  validateAccessAuthority(page.accessContext, page.memberVaultKey, vault, userId)
  if (previousAccess !== null
    && accessAuthoritySignature(previousAccess) !== accessAuthoritySignature(page.accessContext)) {
    throw new VaultDataError('decrypt-failed', 'Snapshot access authority changed between pages')
  }
  if (previousMemberVaultKey !== null
    && JSON.stringify(previousMemberVaultKey) !== JSON.stringify(page.memberVaultKey)) {
    throw new VaultDataError('decrypt-failed', 'Snapshot Vault key changed between pages')
  }
  validatePageItems(page.items, vault, page.accessContext)
}

function validateDeltaPage(
  page: MemberDeltaPage,
  vault: EncryptedVaultSummary,
  userId: string,
  expectedSequence: string,
  previousUpperBound: string | null,
): void {
  validateAccessAuthority(page.accessContext, page.memberVaultKey, vault, userId)
  validatePageItems(page.items, vault, page.accessContext)
  const expected = BigInt(expectedSequence)
  const applied = BigInt(page.appliedThroughSequence)
  const upper = BigInt(page.deltaUpperBound)
  if (previousUpperBound !== null && page.deltaUpperBound !== previousUpperBound) {
    throw new VaultDataError('decrypt-failed', 'Delta upper bound changed between pages')
  }
  if (applied < expected || applied > upper
    || (page.continuationCursor === null && applied !== upper)
    || (page.continuationCursor !== null && applied >= upper)) {
    throw new VaultDataError('decrypt-failed', 'Delta safe-prefix boundary is invalid')
  }
}

function validateAccessAuthority(
  access: OfflineAccessContext,
  memberVaultKey: MemberVaultKeyEnvelope,
  vault: EncryptedVaultSummary,
  userId: string,
): void {
  const descriptor = memberVaultKey.wrappedVaultKey.descriptor
  let lease: ReturnType<typeof accessLeaseBounds>
  try {
    lease = accessLeaseBounds(access)
  } catch {
    throw new VaultDataError('decrypt-failed', 'Offline access lease is invalid')
  }
  const expectedDuration = access.offlinePolicy === 'disabled'
    ? 0
    : access.offlinePolicy === '1h'
      ? 60 * 60_000
      : access.offlinePolicy === '4h'
        ? 4 * 60 * 60_000
        : 24 * 60 * 60_000
  if (access.principalId !== userId
    || access.memberId !== userId
    || access.organizationId !== vault.organizationId
    || access.vaultId !== vault.id
    || access.memberKeyGeneration !== vault.memberKeyGeneration
    || access.vaultKeyVersion !== vault.currentKeyEpoch.vaultKeyVersion
    || descriptor.scope.organizationId !== access.organizationId
    || descriptor.scope.vaultId !== access.vaultId
    || descriptor.scope.memberId !== access.memberId
    || descriptor.memberKeyGeneration !== access.memberKeyGeneration
    || descriptor.wrappedKeyVersion !== access.vaultKeyVersion
    || descriptor.recipientKeyVersion !== access.memberRecipientKeyVersion
    || descriptor.recipientFingerprint !== access.memberRecipientKeyFingerprint
    || JSON.stringify(memberVaultKey) !== JSON.stringify(vault.memberVaultKey)
    || lease.notAfterNanos - lease.issuedAtNanos !== BigInt(expectedDuration) * 1_000_000n) {
    throw new VaultDataError('decrypt-failed', 'Offline access authority binding mismatch')
  }
}

function validatePageItems(
  items: readonly MemberSyncItem[],
  vault: EncryptedVaultSummary,
  access: OfflineAccessContext,
): void {
  const entryIds = new Set<string>()
  for (const item of items) {
    if (entryIds.has(item.entryId)) {
      throw new VaultDataError('decrypt-failed', 'Duplicate Entry in sync page')
    }
    entryIds.add(item.entryId)
    if (item.kind === 'head') validateCompleteItem(item, { vault, accessContext: access })
  }
}

function validateCompleteItem(
  item: Extract<MemberSyncItem, { kind: 'head' }>,
  active: Pick<ActiveCacheState, 'vault' | 'accessContext'>,
): void {
  const entryKey = item.entryKey.descriptor
  const index = item.memberIndex.descriptor
  const secret = item.memberSecret.descriptor
  const descriptors = [entryKey, index, secret]
  if (descriptors.some((descriptor) => descriptor.scope.organizationId !== active.accessContext.organizationId
    || descriptor.scope.vaultId !== active.vault.id
    || descriptor.scope.entryId !== item.entryId
    || descriptor.memberKeyGeneration !== active.accessContext.memberKeyGeneration)
    || item.currentRevision !== item.memberIndexRevision
    || item.currentRevision !== entryKey.resourceRevision
    || item.currentRevision !== index.resourceRevision
    || item.currentRevision !== secret.resourceRevision
    || item.currentKeyVersion !== entryKey.keyVersion
    || item.currentKeyVersion !== index.keyVersion
    || item.currentKeyVersion !== secret.keyVersion
    || entryKey.binding.wrappingVaultKeyVersion !== active.accessContext.vaultKeyVersion) {
    throw new VaultDataError('decrypt-failed', 'Current Entry binding mismatch')
  }
}

function accessSignature(access: OfflineAccessContext): string {
  return JSON.stringify([
    access.contextVersion,
    access.principalId,
    access.organizationId,
    access.organizationMembershipGeneration,
    access.vaultId,
    access.memberId,
    access.memberKeyGeneration,
    access.vaultKeyVersion,
    access.memberRecipientKeyVersion,
    access.memberRecipientKeyFingerprint,
    access.offlinePolicy,
    access.offlinePolicyVersion,
    access.issuedAt,
    access.notAfter,
  ])
}

function accessAuthoritySignature(access: OfflineAccessContext): string {
  return JSON.stringify([
    access.contextVersion,
    access.principalId,
    access.organizationId,
    access.organizationMembershipGeneration,
    access.vaultId,
    access.memberId,
    access.memberKeyGeneration,
    access.vaultKeyVersion,
    access.memberRecipientKeyVersion,
    access.memberRecipientKeyFingerprint,
    access.offlinePolicy,
    access.offlinePolicyVersion,
  ])
}

function accessLeaseBounds(access: OfflineAccessContext): {
  issuedAtMs: number
  notAfterMs: number
  issuedAtNanos: bigint
  notAfterNanos: bigint
} {
  const issuedAtMs = Date.parse(access.issuedAt)
  const notAfterMs = Date.parse(access.notAfter)
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(notAfterMs)) {
    throw new VaultDataError('decrypt-failed', 'Offline access lease is invalid')
  }
  const nanos = (instant: string, milliseconds: number): bigint => {
    const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(instant)?.[1] ?? ''
    const padded = fraction.padEnd(9, '0')
    const parsedMilliseconds = padded.slice(0, 3).padEnd(3, '0')
    const remainder = BigInt(padded || '0') - BigInt(parsedMilliseconds || '0') * 1_000_000n
    return BigInt(milliseconds) * 1_000_000n + remainder
  }
  return {
    issuedAtMs,
    notAfterMs,
    issuedAtNanos: nanos(access.issuedAt, issuedAtMs),
    notAfterNanos: nanos(access.notAfter, notAfterMs),
  }
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
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
      if (parsed.protocol !== 'https:' || registrableDomain(host) === null) {
        throw new Error('unsupported credential URL')
      }
      urlDomain = host
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

function mapTransportError(error: unknown): VaultDataError {
  if (error instanceof VaultDataError) return error
  if (error instanceof VaultClientError) {
    return error.code === 'unauthorized'
      ? new VaultDataError('not-authenticated', 'Session expired')
      : new VaultDataError('network', 'Vault request failed')
  }
  return new VaultDataError('network', 'Vault request failed')
}
