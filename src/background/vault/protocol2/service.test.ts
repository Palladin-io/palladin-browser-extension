import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveCachedEntry, ActiveCacheState, MemberSyncCache } from './cache'
import {
  Protocol2AccessDeniedError,
  Protocol2MutationConflictError,
  Protocol2ResetRequiredError,
  type Protocol2VaultClient,
} from './client'
import type {
  EncryptedVaultSummary,
  MemberSyncItem,
  MemberVaultKeyEnvelope,
  OfflineAccessContext,
} from './contracts'
import { Protocol2VaultDataService, type Protocol2SessionAccessor } from './service'

const cryptoMocks = vi.hoisted(() => ({
  openMemberIndex: vi.fn(),
  openMemberSecret: vi.fn(),
  openVaultProjection: vi.fn(async () => ({
    metadata: { name: 'Personal' },
    vaultKey: new Uint8Array(32).fill(1),
  })),
  openVaultDerivedEnvelope: vi.fn(async () => new Uint8Array(32).fill(2)),
  sealCanonicalEntry: vi.fn(),
  wipe: vi.fn(),
}))

vi.mock('@palladin/crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('@palladin/crypto')>(),
  ...cryptoMocks,
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const VAULT_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

const memberVaultKey = {
  wrappedVaultKey: {
    descriptor: {
      scope: { organizationId: USER_ID, vaultId: VAULT_ID, memberId: USER_ID },
      memberKeyGeneration: 1,
      wrappedKeyVersion: 1,
      recipientKeyVersion: 1,
      recipientFingerprint: 'fingerprint',
    },
  },
} as unknown as MemberVaultKeyEnvelope

const accessContext: OfflineAccessContext = {
  contextVersion: 1,
  principalId: USER_ID,
  organizationId: USER_ID,
  organizationMembershipGeneration: '7',
  vaultId: VAULT_ID,
  memberId: USER_ID,
  memberKeyGeneration: 1,
  vaultKeyVersion: 1,
  memberRecipientKeyVersion: 1,
  memberRecipientKeyFingerprint: 'fingerprint',
  offlinePolicy: '24h',
  offlinePolicyVersion: 1,
  issuedAt: '1970-01-01T00:00:00.000Z',
  notAfter: '1970-01-02T00:00:00.000Z',
}

const connectedOnlyAccessContext = {
  ...accessContext,
  offlinePolicy: 'disabled',
  notAfter: accessContext.issuedAt,
} satisfies OfflineAccessContext

const vault = {
  id: VAULT_ID,
  organizationId: USER_ID,
  isDefault: true,
  metadataRevision: '1',
  memberSequence: '1',
  memberKeyGeneration: 1,
  currentKeyEpoch: { vaultKeyVersion: 1, vdkVersion: 1 },
  memberVaultMetadata: {
    descriptor: {
      resourceRevision: '1',
      scope: { organizationId: USER_ID },
    },
    encodedSuitePayload: 'metadata',
  },
  memberVaultKey,
  discoveryKey: {},
} as unknown as EncryptedVaultSummary

const head = {
  kind: 'head',
  entryId: ENTRY_ID,
  state: 'active',
  updatedAt: '2026-08-16T12:00:00Z',
  currentRevision: '1',
  memberIndexRevision: '1',
  currentKeyVersion: 1,
  entryKey: {
    descriptor: {
      scope: { organizationId: USER_ID, vaultId: VAULT_ID, entryId: ENTRY_ID },
      resourceRevision: '1', keyVersion: 1, memberKeyGeneration: 1,
      binding: { wrappingVaultKeyVersion: 1 },
    },
  },
  memberIndex: {
    descriptor: {
      scope: { organizationId: USER_ID, vaultId: VAULT_ID, entryId: ENTRY_ID },
      resourceRevision: '1', keyVersion: 1, memberKeyGeneration: 1, binding: {},
    },
  },
  memberSecret: {
    descriptor: {
      scope: { organizationId: USER_ID, vaultId: VAULT_ID, entryId: ENTRY_ID },
      resourceRevision: '1', keyVersion: 1, memberKeyGeneration: 1,
      binding: { operation: 'updated' },
    },
  },
} as unknown as MemberSyncItem

function material() {
  return {
    entryKey: { descriptor: { purpose: 8 }, encodedSuitePayload: 'key' },
    memberIndex: { descriptor: { purpose: 5 }, encodedSuitePayload: 'index' },
    memberSecret: { descriptor: { purpose: 6 }, encodedSuitePayload: 'secret' },
    agentDiscovery: null,
  }
}

function harness(
  items: MemberSyncItem[] = [],
  now: () => number = () => 0,
  monotonicNow: () => number = () => 0,
) {
  const active: ActiveCacheState = {
    namespace: 'active',
    appliedThroughSequence: '1',
    vault,
    accessContext,
    memberVaultKey,
    maxObservedWallTime: 0,
  }
  const client = {
    listVaults: vi.fn(async () => [vault]),
    delta: vi.fn(async () => ({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      accessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })),
    snapshot: vi.fn(async () => ({
      snapshotBaseSequence: '1',
      accessContext,
      memberVaultKey,
      items,
      nextCursor: null,
    })),
    getVault: vi.fn(async () => vault),
    getEntry: vi.fn(async () => ({
      organizationId: USER_ID,
      vaultId: VAULT_ID,
      id: ENTRY_ID,
      currentRevision: '1',
      memberIndexRevision: '1',
      agentDiscoveryRevisionHighWatermark: '0',
      currentKeyVersion: 1,
      entryKey: {},
      memberSecret: {},
    })),
    issueEntryCreationChallenge: vi.fn(async () => ENTRY_ID),
    createEntry: vi.fn(async () => ({ id: ENTRY_ID, currentRevision: '1' })),
    updateEntry: vi.fn(async () => ({ currentRevision: '2' })),
  }
  const cache = {
    getActiveState: vi.fn(async (): Promise<ActiveCacheState | null> => active),
    listActiveStates: vi.fn(async () => [active]),
    getProfileUsageBytes: vi.fn(async () => 0),
    readActiveItemPage: vi.fn(async () => ({ active, items, nextEntryId: null })),
    readActiveEntry: vi.fn(async (
      _userId: string,
      _vaultId: string,
      entryId: string,
    ): Promise<ActiveCachedEntry | null> => ({
      active,
      item: items.find((item) => item.entryId === entryId) ?? head,
    })),
    applyActiveDeltaPage: vi.fn(async () => undefined),
    beginSnapshot: vi.fn(async () => undefined),
    applySnapshotPage: vi.fn(async () => undefined),
    applyPendingDeltaPage: vi.fn(async () => undefined),
    completeSnapshot: vi.fn(async () => undefined),
    removeVault: vi.fn(async () => undefined),
    removeMissingVaults: vi.fn(async () => undefined),
    removeProfile: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
  }
  const session: Protocol2SessionAccessor = {
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => null,
    getUserId: async () => USER_ID,
    getPrivateKey: () => new Uint8Array(32).fill(3),
  }
  const service = new Protocol2VaultDataService({
    client: client as unknown as Protocol2VaultClient,
    cache: cache as unknown as MemberSyncCache,
    session,
    now,
    monotonicNow,
  })
  return { service, client, cache, active }
}

beforeEach(() => {
  vi.clearAllMocks()
  cryptoMocks.sealCanonicalEntry.mockResolvedValue(material())
  cryptoMocks.openMemberIndex.mockResolvedValue({
    entryType: 'credential',
    memberLabel: 'Example',
    description: null,
    icon: null,
    color: null,
    username: null,
    urlDomain: 'accounts.example.com',
    customIndex: [],
  })
  cryptoMocks.openMemberSecret.mockResolvedValue({
    schema: 'palladin.member-secret.v1',
    entryType: 'credential',
    memberLabel: 'Example',
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
      username: 'person@example.com',
      password: 'old-password',
      url: 'https://example.com',
      urlDomain: 'accounts.example.com',
      totp: null,
      notes: null,
      customFields: [],
    },
  })
})

describe('Protocol2VaultDataService canonical password capture', () => {
  it('coalesces the unlock refresh and popup sync into one cache transition', async () => {
    const { service, client } = harness([head])
    let resolveVaults: ((value: EncryptedVaultSummary[]) => void) | undefined
    client.listVaults.mockImplementationOnce(() => new Promise((resolve) => {
      resolveVaults = resolve
    }))

    const unlockRefresh = service.repair()
    const popupSync = service.refresh()

    await vi.waitFor(() => expect(client.listVaults).toHaveBeenCalledTimes(1))
    resolveVaults?.([vault])
    await expect(Promise.all([unlockRefresh, popupSync])).resolves.toEqual([
      [expect.objectContaining({ id: ENTRY_ID })],
      [expect.objectContaining({ id: ENTRY_ID })],
    ])
    expect(client.listVaults).toHaveBeenCalledTimes(1)
    expect(client.delta).toHaveBeenCalledTimes(1)
  })

  it('serves a recent UI refresh from the encrypted cache without backend calls', async () => {
    let now = 1_000
    const { service, client } = harness([head], () => now)

    await service.refresh()
    expect(client.listVaults).toHaveBeenCalledTimes(1)

    now += 14 * 60_000
    await service.refreshIfStale(15 * 60_000)
    expect(client.listVaults).toHaveBeenCalledTimes(1)

    now += 60_000
    await service.refreshIfStale(15 * 60_000)
    expect(client.listVaults).toHaveBeenCalledTimes(2)
  })

  it('uses the Vault list as a change manifest and skips unchanged detail and delta requests', async () => {
    const { service, client } = harness([head])

    await service.refresh()

    expect(client.listVaults).toHaveBeenCalledTimes(1)
    expect(client.getVault).not.toHaveBeenCalled()
    expect(client.delta).not.toHaveBeenCalled()
    expect(client.snapshot).not.toHaveBeenCalled()
  })

  it('fetches detail and delta when the authoritative Member sequence advances', async () => {
    const { service, client } = harness([head])
    const advancedVault = { ...vault, memberSequence: '2' }
    client.listVaults.mockResolvedValueOnce([advancedVault])
    client.getVault.mockResolvedValueOnce(advancedVault)
    client.delta.mockResolvedValueOnce({
      deltaUpperBound: '2',
      appliedThroughSequence: '2',
      accessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })

    await service.refresh()

    expect(client.getVault).toHaveBeenCalledWith('token', VAULT_ID)
    expect(client.delta).toHaveBeenCalledWith('token', VAULT_ID, '1', null)
  })

  it('fetches detail when encrypted Vault metadata changes without an Entry sequence change', async () => {
    const { service, client } = harness([head])
    const metadataChanged = {
      ...vault,
      memberVaultMetadata: {
        descriptor: {
          resourceRevision: '2',
          scope: { organizationId: USER_ID },
        },
        encodedSuitePayload: 'next-metadata',
      },
    } as unknown as EncryptedVaultSummary
    client.listVaults.mockResolvedValueOnce([metadataChanged])
    client.getVault.mockResolvedValueOnce(metadataChanged)

    await service.refresh()

    expect(client.getVault).toHaveBeenCalledWith('token', VAULT_ID)
    expect(client.delta).toHaveBeenCalledWith('token', VAULT_ID, '1', null)
  })

  it('fetches detail when the cached authoritative metadata revision does not match the list envelope', async () => {
    const { service, client, cache, active } = harness([head])
    cache.getActiveState
      .mockResolvedValueOnce({
        ...active,
        vault: { ...vault, metadataRevision: '0' },
      })
      .mockResolvedValue(active)

    await service.refresh()

    expect(client.getVault).toHaveBeenCalledWith('token', VAULT_ID)
    expect(client.delta).toHaveBeenCalledWith('token', VAULT_ID, '1', null)
  })

  it('rebuilds disposable ciphertext cache once when a cached projection cannot decrypt', async () => {
    const { service, client, cache } = harness([head])
    cryptoMocks.openMemberIndex
      .mockRejectedValueOnce(new Error('stale cached envelope'))
      .mockResolvedValueOnce({
        entryType: 'credential',
        memberLabel: 'Example',
        description: null,
        icon: null,
        color: null,
        username: null,
        urlDomain: 'accounts.example.com',
        customIndex: [],
      })

    await expect(service.refresh()).resolves.toEqual([
      expect.objectContaining({ id: ENTRY_ID, name: 'Example', vaultName: 'Personal' }),
    ])

    expect(cache.removeMissingVaults).toHaveBeenCalledWith(USER_ID, new Set())
    expect(client.snapshot).toHaveBeenCalledWith('token', VAULT_ID, null)
    expect(cache.completeSnapshot).toHaveBeenCalled()
  })

  it('reuses a cached Vault only when its authoritative metadata revision matches the list envelope', async () => {
    const { service, client } = harness([head])

    await service.refresh()
    await service.getMetadata()

    expect(client.getVault).not.toHaveBeenCalled()
    expect(cryptoMocks.openVaultProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: VAULT_ID,
        organizationId: USER_ID,
        metadataRevision: '1',
      }),
      expect.any(Uint8Array),
      USER_ID,
    )
  })

  it('opens the credential username from cached MemberIndex without fetching MemberSecret', async () => {
    const { service, client } = harness([head])
    cryptoMocks.openMemberIndex.mockResolvedValueOnce({
      entryType: 'credential',
      memberLabel: 'Example',
      description: null,
      icon: null,
      color: null,
      username: 'person@example.com',
      urlDomain: 'accounts.example.com',
      customIndex: [],
    })

    await expect(service.refresh()).resolves.toEqual([
      expect.objectContaining({
        id: ENTRY_ID,
        username: 'person@example.com',
      }),
    ])
    expect(client.getEntry).not.toHaveBeenCalled()
    expect(cryptoMocks.openMemberSecret).not.toHaveBeenCalled()
  })

  it('reveals the cached MemberSecret with zero HTTP requests after a worker restart', async () => {
    const { service, client } = harness([head])

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID)).resolves.toMatchObject({
      entryType: 'credential',
      content: { password: 'old-password' },
    })

    expect(client.listVaults).not.toHaveBeenCalled()
    expect(client.getVault).not.toHaveBeenCalled()
    expect(client.getEntry).not.toHaveBeenCalled()
    expect(client.delta).not.toHaveBeenCalled()
    expect(client.snapshot).not.toHaveBeenCalled()
  })

  it('keeps disabled-policy ciphertext in memory only while connected', async () => {
    const { service, client, cache } = harness([head])
    service.setRealtimeConnected(true)
    cache.getActiveState.mockResolvedValue(null)
    cache.listActiveStates.mockResolvedValue([])
    cache.readActiveEntry.mockResolvedValue(null)
    client.snapshot.mockResolvedValue({
      snapshotBaseSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [head],
      nextCursor: null,
    })
    client.delta.mockResolvedValue({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })

    await expect(service.refresh()).resolves.toEqual([
      expect.objectContaining({ id: ENTRY_ID }),
    ])
    expect(cache.beginSnapshot).not.toHaveBeenCalled()
    expect(cache.applySnapshotPage).not.toHaveBeenCalled()
    const requestsAfterSync = Object.values(client)
      .reduce((count, operation) => count + operation.mock.calls.length, 0)
    await expect(service.revealEntry(VAULT_ID, ENTRY_ID)).resolves.toMatchObject({
      content: { password: 'old-password' },
    })
    expect(Object.values(client).reduce(
      (count, operation) => count + operation.mock.calls.length,
      0,
    )).toBe(requestsAfterSync)

    service.setRealtimeConnected(false)
    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
  })

  it('does not restore disabled-policy access when refresh completes after disconnect', async () => {
    const { service, client, cache } = harness([head])
    service.setRealtimeConnected(true)
    cache.getActiveState.mockResolvedValue(null)
    cache.listActiveStates.mockResolvedValue([])
    cache.readActiveEntry.mockResolvedValue(null)
    client.snapshot.mockResolvedValue({
      snapshotBaseSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [head],
      nextCursor: null,
    })
    client.delta.mockResolvedValue({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })
    let resolveVaults: ((value: EncryptedVaultSummary[]) => void) | undefined
    client.listVaults.mockImplementationOnce(() => new Promise((resolve) => {
      resolveVaults = resolve
    }))

    const refresh = service.refresh()
    await vi.waitFor(() => expect(client.listVaults).toHaveBeenCalledTimes(1))
    service.setRealtimeConnected(false)
    resolveVaults?.([vault])

    await expect(refresh).rejects.toMatchObject({ code: 'network' })
    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.beginSnapshot).not.toHaveBeenCalled()
  })

  it('does not publish an in-flight disabled-policy delta after disconnect', async () => {
    const { service, client, cache } = harness([head])
    service.setRealtimeConnected(true)
    cache.getActiveState.mockResolvedValue(null)
    cache.listActiveStates.mockResolvedValue([])
    cache.readActiveEntry.mockResolvedValue(null)
    client.snapshot.mockResolvedValue({
      snapshotBaseSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [head],
      nextCursor: null,
    })
    client.delta.mockResolvedValue({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })
    await service.refresh()

    let resolveDelta: ((value: Awaited<ReturnType<typeof client.delta>>) => void) | undefined
    client.delta.mockClear()
    client.delta.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDelta = resolve
    }))
    const repair = service.repair()
    await vi.waitFor(() => expect(client.delta).toHaveBeenCalledTimes(1))
    service.setRealtimeConnected(false)
    resolveDelta?.({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      accessContext: connectedOnlyAccessContext,
      memberVaultKey,
      items: [],
      continuationCursor: null,
    })

    await expect(repair).rejects.toMatchObject({ code: 'network' })
    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
  })

  it('fails closed at exact lease expiry and purges the Vault partition', async () => {
    const { service, cache } = harness([head], () => 24 * 60 * 60_000)

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
    expect(cryptoMocks.openMemberSecret).not.toHaveBeenCalled()
  })

  it('rejects a microsecond lease extension beyond the exact policy duration', async () => {
    const { service, cache, active } = harness([head])
    cache.readActiveEntry.mockResolvedValueOnce({
      active: {
        ...active,
        accessContext: { ...accessContext, notAfter: '1970-01-02T00:00:00.000001Z' },
      },
      item: head,
    })

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('fails closed when the wall clock rolls back by more than five minutes', async () => {
    const { service, cache, active } = harness([head])
    cache.readActiveEntry.mockResolvedValueOnce({
      active: { ...active, maxObservedWallTime: 5 * 60_000 + 1 },
      item: head,
    })

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('uses a monotonic deadline so wall-clock rollback cannot extend a live lease', async () => {
    let monotonic = 0
    const { service, cache } = harness([head], () => 0, () => monotonic)
    await service.revealEntry(VAULT_ID, ENTRY_ID)
    monotonic = 24 * 60 * 60_000

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('purges and refuses a cached head with an independently mismatched scope', async () => {
    const { service, cache, active } = harness([head])
    const mismatched = structuredClone(head) as Extract<MemberSyncItem, { kind: 'head' }>
    mismatched.memberSecret.descriptor.scope.vaultId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    cache.readActiveEntry.mockResolvedValueOnce({ active, item: mismatched })

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
    expect(cryptoMocks.openMemberSecret).not.toHaveBeenCalled()
  })

  it.each([
    ['revision', (item: Extract<MemberSyncItem, { kind: 'head' }>) => {
      item.memberSecret.descriptor.resourceRevision = '2'
    }],
    ['key version', (item: Extract<MemberSyncItem, { kind: 'head' }>) => {
      item.memberIndex.descriptor.keyVersion += 1
    }],
  ] as const)('purges a locally cached head with a mismatched %s binding', async (_name, mutate) => {
    const { service, cache, active } = harness([head])
    const mismatched = structuredClone(head) as Extract<MemberSyncItem, { kind: 'head' }>
    mutate(mismatched)
    cache.readActiveEntry.mockResolvedValueOnce({ active, item: mismatched })

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
    expect(cryptoMocks.openMemberSecret).not.toHaveBeenCalled()
  })

  it('purges an internally consistent context bound to another principal', async () => {
    const { service, cache, active } = harness([head])
    const otherPrincipal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    cache.readActiveEntry.mockResolvedValueOnce({
      active: {
        ...active,
        accessContext: {
          ...accessContext,
          principalId: otherPrincipal,
          memberId: otherPrincipal,
        },
      },
      item: head,
    })

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('purges ciphertext when authenticated MemberSecret opening fails', async () => {
    const { service, cache } = harness([head])
    cryptoMocks.openMemberSecret.mockRejectedValueOnce(new Error('authentication failed'))

    await expect(service.revealEntry(VAULT_ID, ENTRY_ID))
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('forces a closing delta during repair even when the Vault manifest is unchanged', async () => {
    const { service, client } = harness([head])

    await service.repair()

    expect(client.delta).toHaveBeenCalledWith('token', VAULT_ID, '1', null)
  })

  it('uses one bounded snapshot request per page, one closing delta and no per-Entry request', async () => {
    const secondEntryId = '44444444-4444-4444-8444-444444444444'
    const second = structuredClone(head) as Extract<MemberSyncItem, { kind: 'head' }>
    Object.assign(second, { entryId: secondEntryId })
    second.entryKey.descriptor.scope.entryId = secondEntryId
    second.memberIndex.descriptor.scope.entryId = secondEntryId
    second.memberSecret.descriptor.scope.entryId = secondEntryId
    const { service, client, cache, active } = harness([head, second])
    cache.getActiveState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(active)

    await service.refresh()

    expect(client.snapshot).toHaveBeenCalledTimes(1)
    expect(client.delta).toHaveBeenCalledTimes(1)
    expect(client.getEntry).not.toHaveBeenCalled()
    expect(cache.applySnapshotPage).toHaveBeenCalledWith(
      USER_ID,
      VAULT_ID,
      expect.any(String),
      [head, second],
      null,
      accessContext,
      memberVaultKey,
      0,
    )
  })

  it('purges active ciphertext before staging a retention-floor reset snapshot', async () => {
    const { service, client, cache } = harness([head])
    client.listVaults.mockResolvedValueOnce([{ ...vault, memberSequence: '2' }])
    client.getVault.mockResolvedValueOnce({ ...vault, memberSequence: '2' })
    client.snapshot.mockResolvedValueOnce({
      snapshotBaseSequence: '2',
      accessContext,
      memberVaultKey,
      items: [head],
      nextCursor: null,
    })
    client.delta
      .mockRejectedValueOnce(new Protocol2ResetRequiredError({
        outcome: 'resetRequired',
        currentSequence: '2',
        minRetainedSequence: '2',
        newSnapshotRequired: true,
      }))
      .mockResolvedValueOnce({
        deltaUpperBound: '2',
        appliedThroughSequence: '2',
        accessContext,
        memberVaultKey,
        items: [],
        continuationCursor: null,
      })

    await service.refresh()

    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
    expect(cache.removeVault.mock.invocationCallOrder[0])
      .toBeLessThan(cache.beginSnapshot.mock.invocationCallOrder[0]!)
  })

  it('rejects a snapshot boundary below the pre-reset high-water mark before staging', async () => {
    const { service, client, cache, active } = harness([head])
    const sequence = '12'
    const currentVault = { ...vault, memberSequence: sequence }
    cache.getActiveState.mockResolvedValue({
      ...active,
      appliedThroughSequence: sequence,
      vault: currentVault,
    })
    client.listVaults.mockResolvedValueOnce([currentVault])
    client.delta.mockRejectedValueOnce(new Protocol2ResetRequiredError({
      outcome: 'resetRequired',
      currentSequence: sequence,
      minRetainedSequence: sequence,
      newSnapshotRequired: true,
    }))
    client.snapshot.mockResolvedValueOnce({
      snapshotBaseSequence: '11',
      accessContext,
      memberVaultKey,
      items: [head],
      nextCursor: null,
    })

    await expect(service.repair())
      .rejects.toMatchObject({ code: 'decrypt-failed' })
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
    expect(cache.beginSnapshot).not.toHaveBeenCalled()
  })

  it('purges immediately when a targeted sync reports revoked access', async () => {
    const { service, client, cache } = harness([head])
    client.getVault.mockRejectedValueOnce(new Protocol2AccessDeniedError())

    await expect(service.applyRealtimeInvalidation(VAULT_ID, false)).resolves.toBeUndefined()
    expect(cache.removeVault).toHaveBeenCalledWith(USER_ID, VAULT_ID)
  })

  it('creates with a server-issued Entry id and empty grant envelopes after explicit save', async () => {
    const { service, client } = harness()
    await service.refresh()

    await expect(service.saveGeneratedPassword({
      kind: 'registration',
      site: 'example.com',
      url: 'https://accounts.example.com/register',
      password: 'generated-password',
    })).resolves.toEqual({ status: 'created' })

    expect(client.issueEntryCreationChallenge).toHaveBeenCalledWith('token', VAULT_ID)
    expect(cryptoMocks.sealCanonicalEntry.mock.calls[0]?.[1]).toMatchObject({
      entryType: 'credential',
      discoverable: false,
      content: {
        password: 'generated-password',
        urlDomain: 'accounts.example.com',
      },
    })
    expect(client.createEntry).toHaveBeenCalledWith('token', expect.objectContaining({
      vaultId: VAULT_ID,
      entryId: ENTRY_ID,
      deliveryPolicy: 'standard',
    }))
  })

  it('updates the unique matching credential and preserves its other fields', async () => {
    const { service, client } = harness([head])
    await service.refresh()

    await expect(service.saveGeneratedPassword({
      kind: 'password-change',
      site: 'example.com',
      url: 'https://accounts.example.com/change-password',
      password: 'next-password',
    })).resolves.toEqual({ status: 'updated' })

    expect(cryptoMocks.sealCanonicalEntry.mock.calls[0]?.[1]).toMatchObject({
      memberLabel: 'Example',
      content: {
        username: 'person@example.com',
        password: 'next-password',
      },
    })
    expect(client.updateEntry).toHaveBeenCalledWith('token', expect.objectContaining({
      baseRevision: '1',
      deliveryPolicy: 'standard',
      grantEnvelopes: [],
    }))
  })

  it('blocks a stale cached match when the latest credential moved to another host', async () => {
    const { service, client } = harness([head])
    await service.refresh()
    cryptoMocks.openMemberSecret.mockResolvedValueOnce({
      schema: 'palladin.member-secret.v1',
      entryType: 'credential',
      memberLabel: 'Moved',
      agentLabel: null,
      discoverable: false,
      description: null,
      icon: null,
      color: null,
      agentFieldAccess: {},
      content: {
        username: 'person@example.com',
        password: 'current-password',
        url: 'https://login.other.test',
        urlDomain: 'login.other.test',
        totp: null,
        notes: null,
        customFields: [],
      },
    })

    await expect(service.saveGeneratedPassword({
      kind: 'password-change',
      site: 'example.com',
      url: 'https://accounts.example.com/change-password',
      password: 'next-password',
    })).resolves.toEqual({ status: 'blocked', reason: 'ambiguous-target' })

    expect(cryptoMocks.sealCanonicalEntry).not.toHaveBeenCalled()
    expect(client.updateEntry).not.toHaveBeenCalled()
  })

  it('keeps a committed create successful when the follow-up refresh fails', async () => {
    const { service, client } = harness()
    await service.refresh()
    client.listVaults.mockRejectedValueOnce(new Error('offline'))

    await expect(service.saveGeneratedPassword({
      kind: 'registration',
      site: 'example.com',
      url: 'https://accounts.example.com/register',
      password: 'generated-password',
    })).resolves.toEqual({ status: 'created' })

    expect(client.createEntry).toHaveBeenCalledTimes(1)
  })

  it('keeps a committed update successful when the follow-up refresh fails', async () => {
    const { service, client } = harness([head])
    await service.refresh()
    client.listVaults.mockRejectedValueOnce(new Error('offline'))

    await expect(service.saveGeneratedPassword({
      kind: 'password-change',
      site: 'example.com',
      url: 'https://accounts.example.com/change-password',
      password: 'next-password',
    })).resolves.toEqual({ status: 'updated' })

    expect(client.updateEntry).toHaveBeenCalledTimes(1)
  })

  it('blocks a password-change save when more than one credential matches the site', async () => {
    const secondEntryId = '44444444-4444-4444-8444-444444444444'
    const second = structuredClone(head) as Extract<MemberSyncItem, { kind: 'head' }>
    Object.assign(second, { entryId: secondEntryId })
    second.entryKey.descriptor.scope.entryId = secondEntryId
    second.memberIndex.descriptor.scope.entryId = secondEntryId
    second.memberSecret.descriptor.scope.entryId = secondEntryId
    const { service, client } = harness([head, second])
    await service.refresh()

    await expect(service.saveGeneratedPassword({
      kind: 'password-change',
      site: 'example.com',
      url: 'https://accounts.example.com/change-password',
      password: 'next-password',
    })).resolves.toEqual({ status: 'blocked', reason: 'ambiguous-target' })

    expect(client.getEntry).not.toHaveBeenCalled()
    expect(client.updateEntry).not.toHaveBeenCalled()
    expect(client.createEntry).not.toHaveBeenCalled()
  })

  it('does not claim success when canonical grant coverage rejects the transition', async () => {
    const { service, client } = harness()
    client.createEntry.mockRejectedValueOnce(new Protocol2MutationConflictError())
    await service.refresh()

    await expect(service.saveGeneratedPassword({
      kind: 'registration',
      site: 'example.com',
      url: 'https://example.com/register',
      password: 'generated-password',
    })).resolves.toEqual({ status: 'blocked', reason: 'grant-refresh-required' })
  })

  it('creates a canonical card with only cardholder, PAN, expiry, billing, notes, and neutral custom fields', async () => {
    const { service, client } = harness()
    await service.refresh()

    await expect(service.saveEntry({
      entryType: 'creditCard',
      label: 'Personal card',
      cardholderName: 'Ada Lovelace',
      cardNumber: '4111 1111 1111 1111',
      expiryMonth: '08',
      expiryYear: '2030',
      billingAddress: '12 Computing Lane',
      notes: 'Primary',
    })).resolves.toEqual({ status: 'saved' })

    const secret = cryptoMocks.sealCanonicalEntry.mock.calls[0]?.[1]
    expect(secret).toMatchObject({
      entryType: 'creditCard',
      discoverable: false,
      content: {
        cardholderName: 'Ada Lovelace',
        cardNumber: '4111111111111111',
        expiryMonth: '08',
        expiryYear: '2030',
        billingAddress: '12 Computing Lane',
        notes: 'Primary',
        customFields: [],
      },
    })
    expect(Object.keys((secret as { content: Record<string, unknown> }).content).sort()).toEqual([
      'billingAddress',
      'cardNumber',
      'cardholderName',
      'customFields',
      'expiryMonth',
      'expiryYear',
      'notes',
    ])
    expect(client.createEntry).toHaveBeenCalled()
  })

  it('creates canonical manual credential, key, and script entries with no implicit Agent disclosure', async () => {
    const { service } = harness()
    await service.refresh()

    await service.saveEntry({
      entryType: 'credential',
      label: 'Example login',
      username: 'ada@example.com',
      password: 'generated-password',
      url: 'https://accounts.example.com/login',
      customFields: [{
        id: 'custom:recovery_hint',
        label: 'Recovery hint',
        type: 'concealed',
        value: 'private note',
      }],
    })
    await service.saveEntry({
      entryType: 'key',
      label: 'API key',
      value: 'secret-key-value',
    })
    await service.saveEntry({
      entryType: 'script',
      label: 'Deploy',
      source: 'echo ok',
      interpreter: 'bash',
    })

    const [credential, key, script] = cryptoMocks.sealCanonicalEntry.mock.calls.map((call) => call[1])
    expect(credential).toMatchObject({
      entryType: 'credential',
      agentFieldAccess: { 'credential.password': 'never', 'custom:recovery_hint': 'never' },
      content: {
        username: 'ada@example.com',
        password: 'generated-password',
        urlDomain: 'accounts.example.com',
        customFields: [{
          id: 'custom:recovery_hint',
          label: 'Recovery hint',
          type: 'concealed',
          value: 'private note',
        }],
      },
    })
    expect(key).toMatchObject({
      entryType: 'key',
      agentFieldAccess: { 'key.value': 'never' },
      content: { value: 'secret-key-value' },
    })
    expect(script).toMatchObject({
      entryType: 'script',
      agentFieldAccess: { 'script.source': 'never' },
      content: { source: 'echo ok', interpreter: 'bash', refs: [] },
    })
  })

  it('rejects credential URLs that can never pass the HTTPS PSL fill gate', async () => {
    const { service } = harness()
    await service.refresh()

    for (const url of [
      'http://accounts.example.com/login',
      'http://localhost:3000/login',
      'https://localhost/login',
      'https://127.0.0.1/login',
    ]) {
      await expect(service.saveEntry({
        entryType: 'credential',
        label: 'Unfillable login',
        username: 'ada@example.com',
        password: 'secret',
        url,
      })).rejects.toMatchObject({ code: 'network' })
    }
  })
})
