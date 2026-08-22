import type { CanonicalEntryEnvelopes } from '@palladin/crypto'
import { z } from 'zod'

import { VaultClientError, type FetchLike } from '../transport'
import {
  canonicalEntryDetailSchema,
  deltaSchema,
  encryptedVaultSummarySchema,
  listVaultsSchema,
  resetSchema,
  snapshotSchema,
  type EncryptedVaultSummary,
  type EncryptedVaultListSummary,
  type MemberDeltaPage,
  type MemberSnapshotPage,
} from './contracts'

const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
const MAXIMUM_VAULTS = 1_000
const PAGE_SIZE = 100

const syncHeaders = {
  'content-type': 'application/json',
  'X-Palladin-Vault-Protocol': '2',
  'X-Palladin-Sync-Policy': '1',
}

export class Protocol2ResetRequiredError extends Error {
  constructor(readonly reset: z.infer<typeof resetSchema>) {
    super('Vault member sync requires a fresh snapshot')
    this.name = 'Protocol2ResetRequiredError'
  }
}

/** A canonical mutation was rejected atomically (grant coverage or stale head). */
export class Protocol2MutationConflictError extends Error {
  constructor() {
    super('Vault mutation requires a newer canonical transition')
    this.name = 'Protocol2MutationConflictError'
  }
}

const creationChallengeSchema = z.object({
  items: z.array(z.object({
    entryId: z.string().uuid(),
    expiresAt: z.string(),
  }).strict()).min(1).max(500),
}).strict()

const createEntryResponseSchema = z.object({
  id: z.string().uuid(),
  currentRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
}).strict()

const updateEntryResponseSchema = z.object({
  currentRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
}).strict()

export interface CreateCanonicalEntryRequest extends CanonicalEntryEnvelopes {
  readonly vaultId: string
  readonly entryId: string
  readonly grantEnvelopes: readonly never[]
}

export interface UpdateCanonicalEntryRequest {
  readonly vaultId: string
  readonly entryId: string
  readonly baseRevision: string
  readonly newEntryKey: CanonicalEntryEnvelopes['entryKey']
  readonly memberSecret: CanonicalEntryEnvelopes['memberSecret']
  readonly memberIndex: CanonicalEntryEnvelopes['memberIndex']
  readonly agentDiscoveryChanged: boolean
  readonly agentDiscovery: CanonicalEntryEnvelopes['agentDiscovery']
  readonly grantEnvelopes: readonly never[]
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAXIMUM_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new VaultClientError('network', 'Vault response exceeds hard byte limit')
    }
  }
  if (!response.body) throw new VaultClientError('network', 'Vault response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAXIMUM_RESPONSE_BYTES) {
        throw new VaultClientError('network', 'Vault response exceeds hard byte limit')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new VaultClientError('network', 'Vault response is not canonical JSON transport')
  }
}

export class Protocol2VaultClient {
  constructor(
    private readonly doFetch: FetchLike,
    private readonly apiUrlSource: string | (() => string),
  ) {}

  private get apiUrl(): string {
    return typeof this.apiUrlSource === 'function' ? this.apiUrlSource() : this.apiUrlSource
  }

  private async request(
    path: string,
    accessToken: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${accessToken}`)
      response = await this.doFetch(`${this.apiUrl}${path}`, {
        ...init,
        headers,
      })
    } catch {
      throw new VaultClientError('network', `Request to ${path} failed`)
    }
    if (response.status === 401) {
      throw new VaultClientError('unauthorized', `Auth rejected at ${path}`)
    }
    return response
  }

  private async parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) {
      throw new VaultClientError('network', `Vault request returned ${response.status}`)
    }
    try {
      return schema.parse(await readBoundedJson(response))
    } catch (error) {
      if (error instanceof VaultClientError) throw error
      throw new VaultClientError('network', 'Vault response failed strict validation')
    }
  }

  async listVaults(accessToken: string, signal?: AbortSignal): Promise<EncryptedVaultListSummary[]> {
    const vaults: EncryptedVaultListSummary[] = []
    let offset = 0
    let total: number | undefined
    do {
      const response = await this.request(
        `/api/vaults?limit=200&offset=${offset}`,
        accessToken,
        { ...(signal ? { signal } : {}) },
      )
      const page = await this.parse(response, listVaultsSchema)
      if (page.total > MAXIMUM_VAULTS) {
        throw new VaultClientError('network', 'Vault count exceeds unlocked client budget')
      }
      vaults.push(...page.vaults)
      offset += page.vaults.length
      total = page.total
      if (page.vaults.length === 0 && offset < total) {
        throw new VaultClientError('network', 'Vault pagination made no progress')
      }
    } while (offset < total)
    return vaults
  }

  async getVault(accessToken: string, vaultId: string, signal?: AbortSignal): Promise<EncryptedVaultSummary> {
    const vault = await this.parse(
      await this.request(`/api/vaults/${encodeURIComponent(vaultId)}`, accessToken, { ...(signal ? { signal } : {}) }),
      encryptedVaultSummarySchema,
    )
    if (vault.id !== vaultId) {
      throw new VaultClientError('network', 'Vault response id does not match the requested Vault')
    }
    return vault
  }

  async snapshot(
    accessToken: string,
    vaultId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<MemberSnapshotPage> {
    const response = await this.request(
      `/api/vaults/${encodeURIComponent(vaultId)}/sync/snapshot`,
      accessToken,
      { method: 'POST', headers: syncHeaders, body: JSON.stringify({ vaultId, cursor, pageSize: PAGE_SIZE }), ...(signal ? { signal } : {}) },
    )
    return this.parse(response, snapshotSchema)
  }

  async delta(
    accessToken: string,
    vaultId: string,
    afterSequence: string | null,
    continuationCursor: string | null,
    signal?: AbortSignal,
  ): Promise<MemberDeltaPage> {
    const response = await this.request(
      `/api/vaults/${encodeURIComponent(vaultId)}/sync/delta`,
      accessToken,
      {
        method: 'POST',
        headers: syncHeaders,
        body: JSON.stringify(continuationCursor
          ? { vaultId, continuationCursor, pageSize: PAGE_SIZE }
          : { vaultId, afterSequence, pageSize: PAGE_SIZE }),
        ...(signal ? { signal } : {}),
      },
    )
    if (response.status === 409) {
      try {
        throw new Protocol2ResetRequiredError(resetSchema.parse(await readBoundedJson(response)))
      } catch (error) {
        if (error instanceof Protocol2ResetRequiredError) throw error
        throw new VaultClientError('network', 'Invalid reset-required response')
      }
    }
    return this.parse(response, deltaSchema)
  }

  async getEntry(accessToken: string, vaultId: string, entryId: string, signal?: AbortSignal) {
    return this.parse(
      await this.request(
        `/api/vaults/${encodeURIComponent(vaultId)}/entries/${encodeURIComponent(entryId)}`,
        accessToken,
        { ...(signal ? { signal } : {}) },
      ),
      canonicalEntryDetailSchema,
    )
  }

  async issueEntryCreationChallenge(
    accessToken: string,
    vaultId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      `/api/vaults/${encodeURIComponent(vaultId)}/entries/creation-challenges`,
      accessToken,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vaultId, count: 1 }),
        ...(signal ? { signal } : {}),
      },
    )
    const parsed = await this.parse(response, creationChallengeSchema)
    return parsed.items[0]!.entryId
  }

  async createEntry(
    accessToken: string,
    request: CreateCanonicalEntryRequest,
    signal?: AbortSignal,
  ): Promise<{ id: string; currentRevision: string }> {
    const response = await this.request(
      `/api/vaults/${encodeURIComponent(request.vaultId)}/entries`,
      accessToken,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      },
    )
    if (response.status === 409) throw new Protocol2MutationConflictError()
    return this.parse(response, createEntryResponseSchema)
  }

  async updateEntry(
    accessToken: string,
    request: UpdateCanonicalEntryRequest,
    signal?: AbortSignal,
  ): Promise<{ currentRevision: string }> {
    const response = await this.request(
      `/api/vaults/${encodeURIComponent(request.vaultId)}/entries/${encodeURIComponent(request.entryId)}`,
      accessToken,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      },
    )
    if (response.status === 409) throw new Protocol2MutationConflictError()
    return this.parse(response, updateEntryResponseSchema)
  }
}
