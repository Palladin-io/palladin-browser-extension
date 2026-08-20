import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { EncryptedVaultSummary, MemberDeltaPage, MemberSyncItem } from './contracts'
import { IndexedDbProtocol2Cache } from './cache'

const userId = '11111111-1111-4111-8111-111111111111'
const vaultId = '22222222-2222-4222-8222-222222222222'

function vault(sequence: string): EncryptedVaultSummary {
  return {
    id: vaultId,
    memberSequence: sequence,
  } as unknown as EncryptedVaultSummary
}

function head(entryId: string, revision: string): MemberSyncItem {
  return {
    kind: 'head',
    entryId,
    state: 'active',
    updatedAt: '2026-07-26T12:00:00Z',
    currentRevision: revision,
    memberIndexRevision: revision,
    currentKeyVersion: 1,
    memberIndex: {},
    entryKey: {},
  } as unknown as MemberSyncItem
}

function delta(sequence: string, items: MemberSyncItem[]): MemberDeltaPage {
  return {
    deltaUpperBound: sequence,
    appliedThroughSequence: sequence,
    continuationCursor: null,
    items,
  }
}

let databaseSequence = 0

function cache(): IndexedDbProtocol2Cache {
  databaseSequence += 1
  return new IndexedDbProtocol2Cache(`palladin-vault-ciphertext-cache-test-${databaseSequence}`)
}

describe('encrypted Protocol 2 sync cache', () => {
  it('discards the disposable pre-v4 cache with the retired zero-based EntryState mapping', async () => {
    const databaseName = `palladin-vault-ciphertext-cache-test-${++databaseSequence}`
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const operation = indexedDB.open(databaseName, 3)
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
      pendingNamespace: null,
      pendingSnapshotBaseSequence: null,
      pendingAppliedThroughSequence: null,
      pendingCursor: null,
      pendingVault: null,
    })
    transaction.objectStore('member-items').put({
      scopeNamespace: `${userId}:${vaultId}:legacy`,
      entryId: '33333333-3333-4333-8333-333333333333',
      item: { ...head('33333333-3333-4333-8333-333333333333', '1'), state: 'archived' },
    })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    legacy.close()

    const subject = new IndexedDbProtocol2Cache(databaseName)

    expect(await subject.getActiveState(userId, vaultId)).toBeNull()
    expect((await subject.readActiveItemPage(userId, vaultId, null, 100)).items).toEqual([])
  })

  it('keeps the prior namespace visible until the replacement snapshot and closing delta commit', async () => {
    const subject = cache()
    const oldEntry = '33333333-3333-4333-8333-333333333333'
    const newEntry = '44444444-4444-4444-8444-444444444444'

    await subject.beginSnapshot(userId, vault('1'), 'old', '1')
    await subject.applySnapshotPage(userId, vaultId, 'old', [head(oldEntry, '1')], null)
    await subject.completeSnapshot(userId, vault('1'), 'old', '1')

    await subject.beginSnapshot(userId, vault('2'), 'new', '2')
    await subject.applySnapshotPage(userId, vaultId, 'new', [head(newEntry, '2')], null)
    await subject.applyPendingDeltaPage(userId, vaultId, 'new', '2', delta('3', []))

    expect((await subject.getActiveState(userId, vaultId))?.namespace).toBe('old')
    expect((await subject.readActiveItemPage(userId, vaultId, null, 100)).items.map((item) => item.entryId)).toEqual([oldEntry])

    await subject.completeSnapshot(userId, vault('3'), 'new', '3')
    expect((await subject.getActiveState(userId, vaultId))?.namespace).toBe('new')
    expect((await subject.readActiveItemPage(userId, vaultId, null, 100)).items.map((item) => item.entryId)).toEqual([newEntry])
  })

  it('keeps the active summary paired with its old namespace when a rekey snapshot is interrupted', async () => {
    const subject = cache()
    await subject.beginSnapshot(userId, vault('1'), 'old', '1')
    await subject.applySnapshotPage(userId, vaultId, 'old', [head('33333333-3333-4333-8333-333333333333', '1')], null)
    await subject.completeSnapshot(userId, vault('1'), 'old', '1')

    await subject.beginSnapshot(userId, vault('9'), 'replacement', '9')

    const active = await subject.getActiveState(userId, vaultId)
    expect(active?.namespace).toBe('old')
    expect(active?.vault.memberSequence).toBe('1')
  })

  it('rolls back item writes when the active delta cursor compare-and-swap fails', async () => {
    const subject = cache()
    const entryId = '33333333-3333-4333-8333-333333333333'
    await subject.beginSnapshot(userId, vault('5'), 'active', '5')
    await subject.applySnapshotPage(userId, vaultId, 'active', [head(entryId, '5')], null)
    await subject.completeSnapshot(userId, vault('5'), 'active', '5')

    await expect(subject.applyActiveDeltaPage(userId, vault('6'), '4', delta('6', [head(entryId, '6')]))).rejects.toThrow('cursor changed')

    expect((await subject.getActiveState(userId, vaultId))?.appliedThroughSequence).toBe('5')
    const [persisted] = (await subject.readActiveItemPage(userId, vaultId, null, 100)).items
    expect(persisted.memberIndexRevision).toBe('5')
  })

  it('applies the page and its cursor atomically and ignores an older retried revision', async () => {
    const subject = cache()
    const entryId = '33333333-3333-4333-8333-333333333333'
    await subject.beginSnapshot(userId, vault('1'), 'active', '1')
    await subject.applySnapshotPage(userId, vaultId, 'active', [head(entryId, '4')], null)
    await subject.completeSnapshot(userId, vault('1'), 'active', '1')

    await subject.applyActiveDeltaPage(userId, vault('2'), '1', delta('2', [head(entryId, '3')]))

    expect((await subject.getActiveState(userId, vaultId))?.appliedThroughSequence).toBe('2')
    const [persisted] = (await subject.readActiveItemPage(userId, vaultId, null, 100)).items
    expect(persisted.memberIndexRevision).toBe('4')
  })

  it('persists ciphertext and structural metadata only', async () => {
    const databaseName = `palladin-vault-ciphertext-cache-test-${++databaseSequence}`
    const subject = new IndexedDbProtocol2Cache(databaseName)
    const item = head('33333333-3333-4333-8333-333333333333', '1')
    await subject.beginSnapshot(userId, vault('1'), 'active', '1')
    await subject.applySnapshotPage(userId, vaultId, 'active', [item], null)
    await subject.completeSnapshot(userId, vault('1'), 'active', '1')

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const operation = indexedDB.open(databaseName)
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const transaction = database.transaction(['member-vaults', 'member-items'], 'readonly')
    const persisted = await Promise.all([
      new Promise<unknown[]>((resolve, reject) => {
        const operation = transaction.objectStore('member-vaults').getAll()
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      }),
      new Promise<unknown[]>((resolve, reject) => {
        const operation = transaction.objectStore('member-items').getAll()
        operation.onsuccess = () => resolve(operation.result)
        operation.onerror = () => reject(operation.error)
      }),
    ])
    const serialized = JSON.stringify(persisted)
    expect(serialized).not.toContain('memberLabel')
    expect(serialized).not.toContain('searchFields')
    expect(serialized).not.toContain('vaultKey')
    expect(serialized).not.toContain('privateKey')
  })

  it('clears every persisted user partition during a server change', async () => {
    const subject = cache()
    const otherUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const entryId = '33333333-3333-4333-8333-333333333333'
    await subject.beginSnapshot(userId, vault('1'), 'first', '1')
    await subject.applySnapshotPage(userId, vaultId, 'first', [head(entryId, '1')], null)
    await subject.completeSnapshot(userId, vault('1'), 'first', '1')
    await subject.beginSnapshot(otherUser, vault('2'), 'second', '2')
    await subject.applySnapshotPage(otherUser, vaultId, 'second', [head(entryId, '2')], null)
    await subject.completeSnapshot(otherUser, vault('2'), 'second', '2')

    await subject.clearAll()

    expect(await subject.getActiveState(userId, vaultId)).toBeNull()
    expect(await subject.getActiveState(otherUser, vaultId)).toBeNull()
    expect((await subject.readActiveItemPage(userId, vaultId, null, 100)).items).toEqual([])
    expect((await subject.readActiveItemPage(otherUser, vaultId, null, 100)).items).toEqual([])
  })
})
