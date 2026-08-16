import type { EncryptedVaultSummary, MemberDeltaPage, MemberSyncItem } from './contracts'

interface CachedVaultState {
  scopeId: string
  userId: string
  vaultId: string
  activeNamespace: string | null
  activeAppliedThroughSequence: string | null
  activeVault: EncryptedVaultSummary | null
  pendingNamespace: string | null
  pendingSnapshotBaseSequence: string | null
  pendingAppliedThroughSequence: string | null
  pendingCursor: string | null
  pendingVault: EncryptedVaultSummary | null
}

interface CachedMemberItem {
  scopeNamespace: string
  entryId: string
  item: MemberSyncItem
}

export interface ActiveCacheState {
  namespace: string
  appliedThroughSequence: string
  vault: EncryptedVaultSummary
}

export interface CachedItemPage {
  items: MemberSyncItem[]
  nextEntryId: string | null
}

export interface MemberSyncCache {
  getActiveState(userId: string, vaultId: string): Promise<ActiveCacheState | null>
  readActiveItemPage(userId: string, vaultId: string, afterEntryId: string | null, limit: number): Promise<CachedItemPage>
  beginSnapshot(userId: string, vault: EncryptedVaultSummary, namespace: string, baseSequence: string): Promise<void>
  applySnapshotPage(userId: string, vaultId: string, namespace: string, items: MemberSyncItem[], nextCursor: string | null): Promise<void>
  applyPendingDeltaPage(userId: string, vaultId: string, namespace: string, expectedSequence: string, page: MemberDeltaPage): Promise<void>
  completeSnapshot(userId: string, vault: EncryptedVaultSummary, namespace: string, appliedThroughSequence: string): Promise<void>
  applyActiveDeltaPage(userId: string, vault: EncryptedVaultSummary, expectedSequence: string, page: MemberDeltaPage): Promise<void>
  removeMissingVaults(userId: string, retainedVaultIds: ReadonlySet<string>): Promise<void>
}

const DATABASE_NAME = 'palladin-vault-ciphertext-cache'
const DATABASE_VERSION = 3
const VAULT_STORE = 'member-vaults'
const ITEM_STORE = 'member-items'
const USER_INDEX = 'userId'
const SCOPE_NAMESPACE_INDEX = 'scopeNamespace'

function scopeId(userId: string, vaultId: string): string {
  return `${userId}:${vaultId}`
}

function scopeNamespace(userId: string, vaultId: string, namespace: string): string {
  return `${scopeId(userId, vaultId)}:${namespace}`
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
  // A request can fail before its caller reaches `await completion`. Attach an
  // observer immediately so the browser never reports a second, unhandled
  // rejection; awaiting the original promise still preserves the failure.
  void completion.catch(() => undefined)
  return completion
}

async function abortTransaction(transaction: IDBTransaction, done: Promise<void>, error: Error): Promise<never> {
  try {
    transaction.abort()
  } catch {
    // The browser may already have aborted the transaction. Its completion
    // promise below remains the authoritative settlement signal.
  }
  await done.catch(() => undefined)
  throw error
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(databaseName, DATABASE_VERSION)
    operation.onupgradeneeded = (event) => {
      const database = operation.result
      if (event.oldVersion === 0) {
        const vaults = database.createObjectStore(VAULT_STORE, { keyPath: 'scopeId' })
        vaults.createIndex(USER_INDEX, 'userId')
        const items = database.createObjectStore(ITEM_STORE, { keyPath: ['scopeNamespace', 'entryId'] })
        items.createIndex(SCOPE_NAMESPACE_INDEX, 'scopeNamespace')
      } else if (event.oldVersion < DATABASE_VERSION) {
        // Older caches either conflate active/pending state or omit the
        // structural UpdatedAt required for deterministic local recents. The
        // cache is disposable ciphertext, so rebuild rather than guessing.
        operation.transaction!.objectStore(VAULT_STORE).clear()
        operation.transaction!.objectStore(ITEM_STORE).clear()
      }
    }
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error ?? new Error('Unable to open Vault ciphertext cache'))
    operation.onblocked = () => reject(new Error('Vault ciphertext cache upgrade is blocked'))
  })
}

function compareRevision(left: MemberSyncItem, right: MemberSyncItem): number {
  if (left.kind === 'tombstone') return 1
  if (right.kind === 'tombstone') return -1
  const leftRevision = BigInt(left.memberIndexRevision)
  const rightRevision = BigInt(right.memberIndexRevision)
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0
}

async function applyItems(store: IDBObjectStore, namespace: string, items: MemberSyncItem[]): Promise<void> {
  for (const item of items) {
    const key: IDBValidKey = [namespace, item.entryId]
    if (item.kind === 'tombstone') {
      await request(store.delete(key))
      continue
    }
    const existing = await request(store.get(key)) as CachedMemberItem | undefined
    if (!existing || compareRevision(existing.item, item) <= 0) {
      await request(store.put({ scopeNamespace: namespace, entryId: item.entryId, item } satisfies CachedMemberItem))
    }
  }
}

async function deleteNamespace(database: IDBDatabase, namespace: string): Promise<void> {
  const transaction = database.transaction(ITEM_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const index = transaction.objectStore(ITEM_STORE).index(SCOPE_NAMESPACE_INDEX)
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openKeyCursor(IDBKeyRange.only(namespace))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Unable to clean old Vault cache namespace'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve()
        return
      }
      transaction.objectStore(ITEM_STORE).delete(cursor.primaryKey)
      cursor.continue()
    }
  })
  await done
}

export class IndexedDbProtocol2Cache implements MemberSyncCache {
  private database: Promise<IDBDatabase> | null = null
  private readonly databaseName: string

  constructor(databaseName = DATABASE_NAME) {
    this.databaseName = databaseName
  }

  private getDatabase(): Promise<IDBDatabase> {
    this.database ??= openDatabase(this.databaseName)
    return this.database
  }

  async getActiveState(userId: string, vaultId: string): Promise<ActiveCacheState | null> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const state = await request(transaction.objectStore(VAULT_STORE).get(scopeId(userId, vaultId))) as CachedVaultState | undefined
    await done
    if (!state?.activeNamespace || state.activeAppliedThroughSequence === null || !state.activeVault) return null
    return { namespace: state.activeNamespace, appliedThroughSequence: state.activeAppliedThroughSequence, vault: state.activeVault }
  }

  async readActiveItemPage(userId: string, vaultId: string, afterEntryId: string | null, limit: number): Promise<CachedItemPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid Vault cache page size')
    const active = await this.getActiveState(userId, vaultId)
    if (!active) return { items: [], nextEntryId: null }
    const namespace = scopeNamespace(userId, vaultId, active.namespace)
    const lower: IDBValidKey = [namespace, afterEntryId ?? '']
    const upper: IDBValidKey = [namespace, '\uffff']
    const range = IDBKeyRange.bound(lower, upper, afterEntryId !== null, false)
    const database = await this.getDatabase()
    const transaction = database.transaction(ITEM_STORE, 'readonly')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ITEM_STORE)
    const items: MemberSyncItem[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = store.openCursor(range)
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Unable to read Vault cache page'))
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor || items.length === limit) {
          resolve()
          return
        }
        items.push((cursor.value as CachedMemberItem).item)
        cursor.continue()
      }
    })
    await done
    return { items, nextEntryId: items.length === limit ? items.at(-1)!.entryId : null }
  }

  async beginSnapshot(userId: string, vault: EncryptedVaultSummary, namespace: string, baseSequence: string): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vault.id)
    const previous = await request(store.get(id)) as CachedVaultState | undefined
    await request(store.put({
      scopeId: id,
      userId,
      vaultId: vault.id,
      activeNamespace: previous?.activeNamespace ?? null,
      activeAppliedThroughSequence: previous?.activeAppliedThroughSequence ?? null,
      activeVault: previous?.activeVault ?? null,
      pendingNamespace: namespace,
      pendingSnapshotBaseSequence: baseSequence,
      pendingAppliedThroughSequence: baseSequence,
      pendingCursor: null,
      pendingVault: vault,
    } satisfies CachedVaultState))
    await done
    if (previous?.pendingNamespace && previous.pendingNamespace !== namespace) {
      await deleteNamespace(database, scopeNamespace(userId, vault.id, previous.pendingNamespace))
    }
  }

  async applySnapshotPage(userId: string, vaultId: string, namespace: string, items: MemberSyncItem[], nextCursor: string | null): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vaultId)
    const state = await request(vaultStore.get(id)) as CachedVaultState | undefined
    if (!state || state.pendingNamespace !== namespace) {
      return abortTransaction(transaction, done, new Error('stale Vault snapshot namespace'))
    }
    await applyItems(transaction.objectStore(ITEM_STORE), scopeNamespace(userId, vaultId, namespace), items)
    await request(vaultStore.put({ ...state, pendingCursor: nextCursor }))
    await done
  }

  async applyPendingDeltaPage(userId: string, vaultId: string, namespace: string, expectedSequence: string, page: MemberDeltaPage): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vaultId)
    const state = await request(vaultStore.get(id)) as CachedVaultState | undefined
    if (!state || state.pendingNamespace !== namespace || state.pendingAppliedThroughSequence !== expectedSequence) {
      return abortTransaction(transaction, done, new Error('Vault pending delta cursor changed concurrently'))
    }
    await applyItems(transaction.objectStore(ITEM_STORE), scopeNamespace(userId, vaultId, namespace), page.items)
    await request(vaultStore.put({ ...state, pendingAppliedThroughSequence: page.appliedThroughSequence }))
    await done
  }

  async completeSnapshot(userId: string, vault: EncryptedVaultSummary, namespace: string, appliedThroughSequence: string): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vault.id)
    const state = await request(store.get(id)) as CachedVaultState | undefined
    if (!state || state.pendingNamespace !== namespace || state.pendingAppliedThroughSequence !== appliedThroughSequence) {
      return abortTransaction(transaction, done, new Error('Vault snapshot completion cursor mismatch'))
    }
    const previousNamespace = state.activeNamespace
    await request(store.put({
      ...state,
      activeNamespace: namespace,
      activeAppliedThroughSequence: appliedThroughSequence,
      activeVault: vault,
      pendingNamespace: null,
      pendingSnapshotBaseSequence: null,
      pendingAppliedThroughSequence: null,
      pendingCursor: null,
      pendingVault: null,
    }))
    await done
    if (previousNamespace && previousNamespace !== namespace) {
      await deleteNamespace(database, scopeNamespace(userId, vault.id, previousNamespace))
    }
  }

  async applyActiveDeltaPage(userId: string, vault: EncryptedVaultSummary, expectedSequence: string, page: MemberDeltaPage): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vault.id)
    const state = await request(vaultStore.get(id)) as CachedVaultState | undefined
    if (!state?.activeNamespace || state.activeAppliedThroughSequence !== expectedSequence) {
      return abortTransaction(transaction, done, new Error('Vault active delta cursor changed concurrently'))
    }
    await applyItems(transaction.objectStore(ITEM_STORE), scopeNamespace(userId, vault.id, state.activeNamespace), page.items)
    await request(vaultStore.put({ ...state, activeAppliedThroughSequence: page.appliedThroughSequence, activeVault: vault }))
    await done
  }

  async removeMissingVaults(userId: string, retainedVaultIds: ReadonlySet<string>): Promise<void> {
    const database = await this.getDatabase()
    const readTransaction = database.transaction(VAULT_STORE, 'readonly')
    const readDone = transactionDone(readTransaction)
    const states = await request(readTransaction.objectStore(VAULT_STORE).index(USER_INDEX).getAll(userId)) as CachedVaultState[]
    await readDone
    for (const state of states) {
      if (retainedVaultIds.has(state.vaultId)) continue
      const transaction = database.transaction(VAULT_STORE, 'readwrite')
      const done = transactionDone(transaction)
      await request(transaction.objectStore(VAULT_STORE).delete(state.scopeId))
      await done
      if (state.activeNamespace) await deleteNamespace(database, scopeNamespace(userId, state.vaultId, state.activeNamespace))
      if (state.pendingNamespace) await deleteNamespace(database, scopeNamespace(userId, state.vaultId, state.pendingNamespace))
    }
  }
}

