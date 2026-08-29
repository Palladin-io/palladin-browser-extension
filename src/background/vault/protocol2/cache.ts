import type {
  EncryptedVaultSummary,
  MemberDeltaPage,
  MemberSyncItem,
  MemberVaultKeyEnvelope,
  OfflineAccessContext,
} from './contracts'

interface CachedVaultState {
  scopeId: string
  userId: string
  vaultId: string
  activeNamespace: string | null
  activeAppliedThroughSequence: string | null
  activeVault: EncryptedVaultSummary | null
  activeAccessContext: OfflineAccessContext | null
  activeMemberVaultKey: MemberVaultKeyEnvelope | null
  activeMaxObservedWallTime: number | null
  activeEncodedBytes: number
  pendingNamespace: string | null
  pendingSnapshotBaseSequence: string | null
  pendingAppliedThroughSequence: string | null
  pendingCursor: string | null
  pendingVault: EncryptedVaultSummary | null
  pendingAccessContext: OfflineAccessContext | null
  pendingMemberVaultKey: MemberVaultKeyEnvelope | null
  pendingMaxObservedWallTime: number | null
  pendingEncodedBytes: number
}

interface CachedMemberItem {
  scopeNamespace: string
  entryId: string
  item: MemberSyncItem
  encodedBytes: number
}

export interface ActiveCacheState {
  namespace: string
  appliedThroughSequence: string
  vault: EncryptedVaultSummary
  accessContext: OfflineAccessContext
  memberVaultKey: MemberVaultKeyEnvelope
  maxObservedWallTime: number
}

export interface CachedItemPage {
  active: ActiveCacheState
  items: MemberSyncItem[]
  nextEntryId: string | null
}

export interface ActiveCachedEntry {
  active: ActiveCacheState
  item: MemberSyncItem
}

export interface MemberSyncCache {
  getActiveState(userId: string, vaultId: string): Promise<ActiveCacheState | null>
  listActiveStates(userId: string): Promise<ActiveCacheState[]>
  getProfileUsageBytes(userId: string): Promise<number>
  readActiveItemPage(
    userId: string,
    vaultId: string,
    afterEntryId: string | null,
    limit: number,
    observedWallTime: number,
  ): Promise<CachedItemPage | null>
  readActiveEntry(
    userId: string,
    vaultId: string,
    entryId: string,
    observedWallTime: number,
  ): Promise<ActiveCachedEntry | null>
  beginSnapshot(
    userId: string,
    vault: EncryptedVaultSummary,
    namespace: string,
    baseSequence: string,
    accessContext: OfflineAccessContext,
    memberVaultKey: MemberVaultKeyEnvelope,
    observedWallTime: number,
  ): Promise<void>
  applySnapshotPage(
    userId: string,
    vaultId: string,
    namespace: string,
    items: MemberSyncItem[],
    nextCursor: string | null,
    accessContext: OfflineAccessContext,
    memberVaultKey: MemberVaultKeyEnvelope,
    observedWallTime: number,
  ): Promise<void>
  applyPendingDeltaPage(
    userId: string,
    vaultId: string,
    namespace: string,
    expectedSequence: string,
    page: MemberDeltaPage,
    observedWallTime: number,
  ): Promise<void>
  completeSnapshot(
    userId: string,
    vault: EncryptedVaultSummary,
    namespace: string,
    appliedThroughSequence: string,
  ): Promise<void>
  applyActiveDeltaPage(
    userId: string,
    vault: EncryptedVaultSummary,
    expectedSequence: string,
    page: MemberDeltaPage,
    observedWallTime: number,
  ): Promise<void>
  removeVault(userId: string, vaultId: string): Promise<void>
  removeMissingVaults(userId: string, retainedVaultIds: ReadonlySet<string>): Promise<void>
  removeProfile(userId: string): Promise<void>
  clearAll(): Promise<void>
}

const DATABASE_NAME = 'palladin-vault-ciphertext-cache'
const DATABASE_VERSION = 5
const VAULT_STORE = 'member-vaults'
const ITEM_STORE = 'member-items'
const USER_INDEX = 'userId'
const SCOPE_NAMESPACE_INDEX = 'scopeNamespace'
export const MAXIMUM_PROFILE_CACHE_BYTES = 512 * 1024 * 1024

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
  void completion.catch(() => undefined)
  return completion
}

async function abortTransaction(
  transaction: IDBTransaction,
  done: Promise<void>,
  error: Error,
): Promise<never> {
  try {
    transaction.abort()
  } catch {
    // The transaction may already be aborting after a failed request.
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
        operation.transaction!.objectStore(VAULT_STORE).clear()
        operation.transaction!.objectStore(ITEM_STORE).clear()
      }
    }
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error ?? new Error('Unable to open Vault ciphertext cache'))
    operation.onblocked = () => reject(new Error('Vault ciphertext cache upgrade is blocked'))
  })
}

function activeState(state: CachedVaultState): ActiveCacheState | null {
  if (!state.activeNamespace
    || state.activeAppliedThroughSequence === null
    || !state.activeVault
    || !state.activeAccessContext
    || !state.activeMemberVaultKey
    || state.activeMaxObservedWallTime === null) return null
  return {
    namespace: state.activeNamespace,
    appliedThroughSequence: state.activeAppliedThroughSequence,
    vault: state.activeVault,
    accessContext: state.activeAccessContext,
    memberVaultKey: state.activeMemberVaultKey,
    maxObservedWallTime: state.activeMaxObservedWallTime,
  }
}

function encodedBytes(item: MemberSyncItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).byteLength
}

function encodedStateBytes(state: CachedVaultState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength
}

function compareRevision(left: MemberSyncItem, right: MemberSyncItem): number {
  if (left.kind === 'tombstone') return right.kind === 'tombstone' ? 0 : 1
  if (right.kind === 'tombstone') return -1
  const leftRevision = BigInt(left.currentRevision)
  const rightRevision = BigInt(right.currentRevision)
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0
}

async function applyItems(
  store: IDBObjectStore,
  namespace: string,
  items: MemberSyncItem[],
  currentBytes: number,
): Promise<number> {
  let nextBytes = currentBytes
  for (const item of items) {
    const key: IDBValidKey = [namespace, item.entryId]
    const existing = await request(store.get(key)) as CachedMemberItem | undefined
    if (existing && compareRevision(existing.item, item) > 0) continue
    const itemBytes = encodedBytes(item)
    await request(store.put({
      scopeNamespace: namespace,
      entryId: item.entryId,
      item,
      encodedBytes: itemBytes,
    } satisfies CachedMemberItem))
    nextBytes += itemBytes - (existing?.encodedBytes ?? 0)
  }
  return nextBytes
}

async function deleteNamespacePrefix(store: IDBObjectStore, prefix: string): Promise<void> {
  const index = store.index(SCOPE_NAMESPACE_INDEX)
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Unable to clean Vault cache namespace'))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve()
        return
      }
      store.delete(cursor.primaryKey)
      cursor.continue()
    }
  })
}

async function assertProfileQuota(
  vaultStore: IDBObjectStore,
  userId: string,
  nextState: CachedVaultState,
  transaction: IDBTransaction,
  done: Promise<void>,
  maximumBytes: number,
): Promise<void> {
  const states = await request(vaultStore.index(USER_INDEX).getAll(userId)) as CachedVaultState[]
  let found = false
  let bytes = 0
  for (const state of states) {
    const candidate = state.scopeId === nextState.scopeId ? nextState : state
    found ||= state.scopeId === nextState.scopeId
    bytes += candidate.activeEncodedBytes + candidate.pendingEncodedBytes + encodedStateBytes(candidate)
  }
  if (!found) {
    bytes += nextState.activeEncodedBytes + nextState.pendingEncodedBytes + encodedStateBytes(nextState)
  }
  if (bytes > maximumBytes) {
    await abortTransaction(transaction, done, new Error('Vault ciphertext cache quota exceeded'))
  }
}

export class IndexedDbProtocol2Cache implements MemberSyncCache {
  private database: Promise<IDBDatabase> | null = null

  constructor(
    private readonly databaseName = DATABASE_NAME,
    private readonly maximumProfileCacheBytes = MAXIMUM_PROFILE_CACHE_BYTES,
  ) {}

  private getDatabase(): Promise<IDBDatabase> {
    this.database ??= openDatabase(this.databaseName)
    return this.database
  }

  async clearAll(): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    await Promise.all([
      request(transaction.objectStore(VAULT_STORE).clear()),
      request(transaction.objectStore(ITEM_STORE).clear()),
    ])
    await done
  }

  async getActiveState(userId: string, vaultId: string): Promise<ActiveCacheState | null> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const state = await request(
      transaction.objectStore(VAULT_STORE).get(scopeId(userId, vaultId)),
    ) as CachedVaultState | undefined
    await done
    return state ? activeState(state) : null
  }

  async listActiveStates(userId: string): Promise<ActiveCacheState[]> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const states = await request(
      transaction.objectStore(VAULT_STORE).index(USER_INDEX).getAll(userId),
    ) as CachedVaultState[]
    await done
    return states.flatMap((state) => {
      const active = activeState(state)
      return active ? [active] : []
    })
  }

  async getProfileUsageBytes(userId: string): Promise<number> {
    const database = await this.getDatabase()
    const transaction = database.transaction(VAULT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const states = await request(
      transaction.objectStore(VAULT_STORE).index(USER_INDEX).getAll(userId),
    ) as CachedVaultState[]
    await done
    return states.reduce(
      (total, state) => total + state.activeEncodedBytes + state.pendingEncodedBytes
        + encodedStateBytes(state),
      0,
    )
  }

  async readActiveItemPage(
    userId: string,
    vaultId: string,
    afterEntryId: string | null,
    limit: number,
    observedWallTime: number,
  ): Promise<CachedItemPage | null> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('invalid Vault cache page size')
    }
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const state = await request(vaultStore.get(scopeId(userId, vaultId))) as CachedVaultState | undefined
    const active = state ? activeState(state) : null
    if (!state || !active) {
      await done
      return null
    }
    const nextObserved = Math.max(active.maxObservedWallTime, observedWallTime)
    await request(vaultStore.put({ ...state, activeMaxObservedWallTime: nextObserved }))
    const namespace = scopeNamespace(userId, vaultId, active.namespace)
    const lower: IDBValidKey = [namespace, afterEntryId ?? '']
    const upper: IDBValidKey = [namespace, '\uffff']
    const range = IDBKeyRange.bound(lower, upper, afterEntryId !== null, false)
    const items: MemberSyncItem[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = transaction.objectStore(ITEM_STORE).openCursor(range)
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
    return {
      active: { ...active, maxObservedWallTime: nextObserved },
      items,
      nextEntryId: items.length === limit ? items.at(-1)!.entryId : null,
    }
  }

  async readActiveEntry(
    userId: string,
    vaultId: string,
    entryId: string,
    observedWallTime: number,
  ): Promise<ActiveCachedEntry | null> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const state = await request(vaultStore.get(scopeId(userId, vaultId))) as CachedVaultState | undefined
    const active = state ? activeState(state) : null
    if (!state || !active) {
      await done
      return null
    }
    const nextObserved = Math.max(active.maxObservedWallTime, observedWallTime)
    await request(vaultStore.put({ ...state, activeMaxObservedWallTime: nextObserved }))
    const cached = await request(transaction.objectStore(ITEM_STORE).get([
      scopeNamespace(userId, vaultId, active.namespace),
      entryId,
    ])) as CachedMemberItem | undefined
    await done
    return cached
      ? { active: { ...active, maxObservedWallTime: nextObserved }, item: cached.item }
      : null
  }

  async beginSnapshot(
    userId: string,
    vault: EncryptedVaultSummary,
    namespace: string,
    baseSequence: string,
    accessContext: OfflineAccessContext,
    memberVaultKey: MemberVaultKeyEnvelope,
    observedWallTime: number,
  ): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(VAULT_STORE)
    const id = scopeId(userId, vault.id)
    const previous = await request(store.get(id)) as CachedVaultState | undefined
    if (previous?.pendingNamespace) {
      await deleteNamespacePrefix(
        transaction.objectStore(ITEM_STORE),
        scopeNamespace(userId, vault.id, previous.pendingNamespace),
      )
    }
    const next: CachedVaultState = {
      scopeId: id,
      userId,
      vaultId: vault.id,
      activeNamespace: previous?.activeNamespace ?? null,
      activeAppliedThroughSequence: previous?.activeAppliedThroughSequence ?? null,
      activeVault: previous?.activeVault ?? null,
      activeAccessContext: previous?.activeAccessContext ?? null,
      activeMemberVaultKey: previous?.activeMemberVaultKey ?? null,
      activeMaxObservedWallTime: previous?.activeMaxObservedWallTime ?? null,
      activeEncodedBytes: previous?.activeEncodedBytes ?? 0,
      pendingNamespace: namespace,
      pendingSnapshotBaseSequence: baseSequence,
      pendingAppliedThroughSequence: baseSequence,
      pendingCursor: null,
      pendingVault: vault,
      pendingAccessContext: accessContext,
      pendingMemberVaultKey: memberVaultKey,
      pendingMaxObservedWallTime: observedWallTime,
      pendingEncodedBytes: 0,
    }
    await assertProfileQuota(
      store,
      userId,
      next,
      transaction,
      done,
      this.maximumProfileCacheBytes,
    )
    await request(store.put(next))
    await done
  }

  async applySnapshotPage(
    userId: string,
    vaultId: string,
    namespace: string,
    items: MemberSyncItem[],
    nextCursor: string | null,
    accessContext: OfflineAccessContext,
    memberVaultKey: MemberVaultKeyEnvelope,
    observedWallTime: number,
  ): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const state = await request(vaultStore.get(scopeId(userId, vaultId))) as CachedVaultState | undefined
    if (!state
      || state.pendingNamespace !== namespace
      || state.pendingSnapshotBaseSequence === null) {
      return abortTransaction(transaction, done, new Error('stale Vault snapshot namespace'))
    }
    const bytes = await applyItems(
      transaction.objectStore(ITEM_STORE),
      scopeNamespace(userId, vaultId, namespace),
      items,
      state.pendingEncodedBytes,
    )
    const next = {
      ...state,
      pendingCursor: nextCursor,
      pendingAccessContext: accessContext,
      pendingMemberVaultKey: memberVaultKey,
      pendingMaxObservedWallTime: Math.max(state.pendingMaxObservedWallTime ?? 0, observedWallTime),
      pendingEncodedBytes: bytes,
    }
    await assertProfileQuota(
      vaultStore,
      userId,
      next,
      transaction,
      done,
      this.maximumProfileCacheBytes,
    )
    await request(vaultStore.put(next))
    await done
  }

  async applyPendingDeltaPage(
    userId: string,
    vaultId: string,
    namespace: string,
    expectedSequence: string,
    page: MemberDeltaPage,
    observedWallTime: number,
  ): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const state = await request(vaultStore.get(scopeId(userId, vaultId))) as CachedVaultState | undefined
    if (!state
      || state.pendingNamespace !== namespace
      || state.pendingAppliedThroughSequence !== expectedSequence) {
      return abortTransaction(transaction, done, new Error('Vault pending delta cursor changed concurrently'))
    }
    const bytes = await applyItems(
      transaction.objectStore(ITEM_STORE),
      scopeNamespace(userId, vaultId, namespace),
      page.items,
      state.pendingEncodedBytes,
    )
    const next = {
      ...state,
      pendingAppliedThroughSequence: page.appliedThroughSequence,
      pendingAccessContext: page.accessContext,
      pendingMemberVaultKey: page.memberVaultKey,
      pendingMaxObservedWallTime: Math.max(state.pendingMaxObservedWallTime ?? 0, observedWallTime),
      pendingEncodedBytes: bytes,
    }
    await assertProfileQuota(
      vaultStore,
      userId,
      next,
      transaction,
      done,
      this.maximumProfileCacheBytes,
    )
    await request(vaultStore.put(next))
    await done
  }

  async completeSnapshot(
    userId: string,
    vault: EncryptedVaultSummary,
    namespace: string,
    appliedThroughSequence: string,
  ): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(VAULT_STORE)
    const state = await request(store.get(scopeId(userId, vault.id))) as CachedVaultState | undefined
    if (!state
      || state.pendingNamespace !== namespace
      || state.pendingAppliedThroughSequence !== appliedThroughSequence
      || !state.pendingAccessContext
      || !state.pendingMemberVaultKey
      || state.pendingMaxObservedWallTime === null) {
      return abortTransaction(transaction, done, new Error('Vault snapshot completion cursor mismatch'))
    }
    if (state.activeNamespace && state.activeNamespace !== namespace) {
      await deleteNamespacePrefix(
        transaction.objectStore(ITEM_STORE),
        scopeNamespace(userId, vault.id, state.activeNamespace),
      )
    }
    await request(store.put({
      ...state,
      activeNamespace: namespace,
      activeAppliedThroughSequence: appliedThroughSequence,
      activeVault: vault,
      activeAccessContext: state.pendingAccessContext,
      activeMemberVaultKey: state.pendingMemberVaultKey,
      activeMaxObservedWallTime: state.pendingMaxObservedWallTime,
      activeEncodedBytes: state.pendingEncodedBytes,
      pendingNamespace: null,
      pendingSnapshotBaseSequence: null,
      pendingAppliedThroughSequence: null,
      pendingCursor: null,
      pendingVault: null,
      pendingAccessContext: null,
      pendingMemberVaultKey: null,
      pendingMaxObservedWallTime: null,
      pendingEncodedBytes: 0,
    }))
    await done
  }

  async applyActiveDeltaPage(
    userId: string,
    vault: EncryptedVaultSummary,
    expectedSequence: string,
    page: MemberDeltaPage,
    observedWallTime: number,
  ): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const state = await request(vaultStore.get(scopeId(userId, vault.id))) as CachedVaultState | undefined
    if (!state?.activeNamespace || state.activeAppliedThroughSequence !== expectedSequence) {
      return abortTransaction(transaction, done, new Error('Vault active delta cursor changed concurrently'))
    }
    const bytes = await applyItems(
      transaction.objectStore(ITEM_STORE),
      scopeNamespace(userId, vault.id, state.activeNamespace),
      page.items,
      state.activeEncodedBytes,
    )
    const next = {
      ...state,
      activeAppliedThroughSequence: page.appliedThroughSequence,
      activeVault: vault,
      activeAccessContext: page.accessContext,
      activeMemberVaultKey: page.memberVaultKey,
      activeMaxObservedWallTime: Math.max(state.activeMaxObservedWallTime ?? 0, observedWallTime),
      activeEncodedBytes: bytes,
    }
    await assertProfileQuota(
      vaultStore,
      userId,
      next,
      transaction,
      done,
      this.maximumProfileCacheBytes,
    )
    await request(vaultStore.put(next))
    await done
  }

  async removeMissingVaults(userId: string, retainedVaultIds: ReadonlySet<string>): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const states = await request(vaultStore.index(USER_INDEX).getAll(userId)) as CachedVaultState[]
    for (const state of states) {
      if (retainedVaultIds.has(state.vaultId)) continue
      await request(vaultStore.delete(state.scopeId))
      await deleteNamespacePrefix(transaction.objectStore(ITEM_STORE), `${scopeId(userId, state.vaultId)}:`)
    }
    await done
  }

  async removeVault(userId: string, vaultId: string): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    await request(transaction.objectStore(VAULT_STORE).delete(scopeId(userId, vaultId)))
    await deleteNamespacePrefix(transaction.objectStore(ITEM_STORE), `${scopeId(userId, vaultId)}:`)
    await done
  }

  async removeProfile(userId: string): Promise<void> {
    const database = await this.getDatabase()
    const transaction = database.transaction([VAULT_STORE, ITEM_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const vaultStore = transaction.objectStore(VAULT_STORE)
    const states = await request(vaultStore.index(USER_INDEX).getAll(userId)) as CachedVaultState[]
    await Promise.all(states.map((state) => request(vaultStore.delete(state.scopeId))))
    await deleteNamespacePrefix(transaction.objectStore(ITEM_STORE), `${userId}:`)
    await done
  }
}
