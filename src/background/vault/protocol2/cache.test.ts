import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import type {
  EncryptedVaultSummary,
  MemberDeltaPage,
  MemberSyncItem,
  MemberVaultKeyEnvelope,
  OfflineAccessContext,
} from './contracts'
import { IndexedDbProtocol2Cache, MAXIMUM_PROFILE_CACHE_BYTES } from './cache'

const userId = '11111111-1111-4111-8111-111111111111'
const vaultId = '22222222-2222-4222-8222-222222222222'
const entryId = '33333333-3333-4333-8333-333333333333'
const observedAt = Date.parse('2026-08-29T08:30:00Z')

function vault(sequence: string): EncryptedVaultSummary {
  return { id: vaultId, memberSequence: sequence } as unknown as EncryptedVaultSummary
}

function access(memberId = userId): OfflineAccessContext {
  return {
    contextVersion: 1,
    principalId: memberId,
    organizationId: userId,
    organizationMembershipGeneration: '7',
    vaultId,
    memberId,
    memberKeyGeneration: 4,
    vaultKeyVersion: 3,
    memberRecipientKeyVersion: 2,
    memberRecipientKeyFingerprint: 'fingerprint',
    offlinePolicy: '24h',
    offlinePolicyVersion: 1,
    issuedAt: '2026-08-29T08:00:00Z',
    notAfter: '2026-08-30T08:00:00Z',
  }
}

function memberVaultKey(): MemberVaultKeyEnvelope {
  const value = { wrappedVaultKey: { descriptor: {}, encodedSealedKeyPackage: 'ciphertext' } }
  return value as unknown as MemberVaultKeyEnvelope
}

function head(revision: string, payload = 'ciphertext'): MemberSyncItem {
  return {
    kind: 'head',
    entryId,
    state: 'active',
    updatedAt: '2026-08-29T08:12:00Z',
    currentRevision: revision,
    memberIndexRevision: revision,
    currentKeyVersion: 1,
    memberIndex: { encodedSuitePayload: payload },
    memberSecret: { encodedSuitePayload: payload },
    entryKey: { encodedSuitePayload: payload },
  } as unknown as MemberSyncItem
}

function tombstone(): MemberSyncItem {
  return {
    entryId,
    kind: 'tombstone',
    state: null,
    updatedAt: null,
    currentRevision: null,
    memberIndexRevision: null,
    currentKeyVersion: null,
    entryKey: null,
    memberIndex: null,
    memberSecret: null,
  }
}

function delta(sequence: string, items: MemberSyncItem[]): MemberDeltaPage {
  return {
    deltaUpperBound: sequence,
    appliedThroughSequence: sequence,
    accessContext: access(),
    memberVaultKey: memberVaultKey(),
    continuationCursor: null,
    items,
  }
}

let databaseSequence = 0

function cache(maximumBytes?: number): IndexedDbProtocol2Cache {
  databaseSequence += 1
  return new IndexedDbProtocol2Cache(
    `palladin-vault-ciphertext-cache-test-${databaseSequence}`,
    maximumBytes,
  )
}

async function install(
  subject: IndexedDbProtocol2Cache,
  namespace: string,
  sequence: string,
  items: MemberSyncItem[],
  profileUserId = userId,
): Promise<void> {
  await subject.beginSnapshot(
    profileUserId,
    vault(sequence),
    namespace,
    sequence,
    access(profileUserId),
    memberVaultKey(),
    observedAt,
  )
  await subject.applySnapshotPage(
    profileUserId,
    vaultId,
    namespace,
    items,
    null,
    access(profileUserId),
    memberVaultKey(),
    observedAt,
  )
  await subject.completeSnapshot(profileUserId, vault(sequence), namespace, sequence)
}

describe('encrypted Protocol 2 current-entry cache', () => {
  it('clears the disposable v4 policy-1 database during the v5 upgrade', async () => {
    const databaseName = `palladin-vault-ciphertext-cache-test-${++databaseSequence}`
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const operation = indexedDB.open(databaseName, 4)
      operation.onupgradeneeded = () => {
        const vaults = operation.result.createObjectStore('member-vaults', { keyPath: 'scopeId' })
        vaults.createIndex('userId', 'userId')
        const items = operation.result.createObjectStore('member-items', { keyPath: ['scopeNamespace', 'entryId'] })
        items.createIndex('scopeNamespace', 'scopeNamespace')
      }
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const transaction = legacy.transaction(['member-vaults', 'member-items'], 'readwrite')
    transaction.objectStore('member-vaults').put({
      scopeId: `${userId}:${vaultId}`,
      userId,
      vaultId,
      activeNamespace: 'legacy',
      activeAppliedThroughSequence: '1',
      activeVault: vault('1'),
    })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    legacy.close()

    const subject = new IndexedDbProtocol2Cache(databaseName)
    expect(await subject.getActiveState(userId, vaultId)).toBeNull()
    expect(await subject.readActiveItemPage(userId, vaultId, null, 100, observedAt)).toBeNull()
  })

  it('keeps the active namespace visible until snapshot plus closing delta commit', async () => {
    const subject = cache()
    await install(subject, 'old', '1', [head('1')])

    await subject.beginSnapshot(userId, vault('2'), 'new', '2', access(), memberVaultKey(), observedAt)
    await subject.applySnapshotPage(
      userId, vaultId, 'new', [head('2')], null, access(), memberVaultKey(), observedAt,
    )
    await subject.applyPendingDeltaPage(userId, vaultId, 'new', '2', delta('3', []), observedAt)

    expect((await subject.getActiveState(userId, vaultId))?.namespace).toBe('old')
    await subject.completeSnapshot(userId, vault('3'), 'new', '3')
    expect((await subject.getActiveState(userId, vaultId))?.namespace).toBe('new')
  })

  it('rolls back item writes when the active cursor compare-and-swap fails', async () => {
    const subject = cache()
    await install(subject, 'active', '5', [head('5')])

    await expect(subject.applyActiveDeltaPage(
      userId, vault('6'), '4', delta('6', [head('6')]), observedAt,
    )).rejects.toThrow('cursor changed')

    expect((await subject.getActiveState(userId, vaultId))?.appliedThroughSequence).toBe('5')
    expect((await subject.readActiveEntry(userId, vaultId, entryId, observedAt))?.item)
      .toMatchObject({ currentRevision: '5' })
  })

  it('never resurrects a tombstone with a delayed old head, including after reset staging', async () => {
    const subject = cache()
    await install(subject, 'active', '5', [head('5')])
    await subject.applyActiveDeltaPage(userId, vault('6'), '5', delta('6', [tombstone()]), observedAt)
    await subject.applyActiveDeltaPage(userId, vault('7'), '6', delta('7', [head('99')]), observedAt)
    expect((await subject.readActiveEntry(userId, vaultId, entryId, observedAt))?.item.kind)
      .toBe('tombstone')

    await subject.removeVault(userId, vaultId)
    await subject.beginSnapshot(
      userId, vault('8'), 'reset', '8', access(), memberVaultKey(), observedAt,
    )
    await subject.applySnapshotPage(
      userId, vaultId, 'reset', [tombstone()], 'next-page', access(), memberVaultKey(), observedAt,
    )
    await subject.applySnapshotPage(
      userId, vaultId, 'reset', [head('100')], null, access(), memberVaultKey(), observedAt,
    )
    await subject.completeSnapshot(userId, vault('8'), 'reset', '8')
    expect((await subject.readActiveEntry(userId, vaultId, entryId, observedAt))?.item.kind)
      .toBe('tombstone')
  })

  it('enforces the 512 MiB profile quota and aborts an over-quota generation atomically', async () => {
    expect(MAXIMUM_PROFILE_CACHE_BYTES).toBe(512 * 1024 * 1024)
    const subject = cache(5_000)
    await install(subject, 'active', '1', [head('1')])
    await subject.beginSnapshot(userId, vault('2'), 'pending', '2', access(), memberVaultKey(), observedAt)

    await expect(subject.applySnapshotPage(
      userId,
      vaultId,
      'pending',
      [head('2', 'x'.repeat(5_000))],
      null,
      access(),
      memberVaultKey(),
      observedAt,
    )).rejects.toThrow('quota exceeded')

    expect(await subject.getActiveState(userId, vaultId)).toMatchObject({
      namespace: 'active',
      appliedThroughSequence: '1',
    })
    expect(await subject.readActiveEntry(userId, vaultId, entryId, observedAt))
      .toMatchObject({ item: { currentRevision: '1' } })
  })

  it('persists only ciphertext, structural authority and rollback metadata', async () => {
    const databaseName = `palladin-vault-ciphertext-cache-test-${++databaseSequence}`
    const subject = new IndexedDbProtocol2Cache(databaseName)
    await install(subject, 'active', '1', [head('1')])

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const operation = indexedDB.open(databaseName)
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const transaction = database.transaction(['member-vaults', 'member-items'], 'readonly')
    const values = await Promise.all(['member-vaults', 'member-items'].map((name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const operation = transaction.objectStore(name).getAll()
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      })))
    const serialized = JSON.stringify(values)
    expect(serialized).not.toContain('memberLabel')
    expect(serialized).not.toContain('privateKey')
    expect(serialized).toContain('activeAccessContext')
    expect(serialized).toContain('activeMaxObservedWallTime')
  })

  it('removes exactly one profile on logout and every profile on server change', async () => {
    const subject = cache()
    const otherUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await install(subject, 'first', '1', [head('1')])
    await install(subject, 'second', '2', [head('2')], otherUser)

    await subject.removeProfile(userId)
    expect(await subject.getActiveState(userId, vaultId)).toBeNull()
    expect(await subject.getActiveState(otherUser, vaultId)).not.toBeNull()

    await subject.clearAll()
    expect(await subject.getActiveState(otherUser, vaultId)).toBeNull()
  })
})
