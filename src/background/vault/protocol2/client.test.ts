import { describe, expect, it, vi } from 'vitest'

import { Protocol2ResetRequiredError, Protocol2VaultClient } from './client'

const API = 'https://api.test'
const TOKEN = 'opaque-access-token'
const VAULT_ID = '22222222-2222-4222-8222-222222222222'

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('Protocol2VaultClient transport boundary', () => {
  it('paginates the strict Vault list and authenticates without logging values', async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      return json({ vaults: [], total: 0 })
    })

    await expect(new Protocol2VaultClient(doFetch, API).listVaults(TOKEN)).resolves.toEqual([])
    expect(String(doFetch.mock.calls[0]?.[0])).toBe(`${API}/api/vaults?limit=200&offset=0`)
  })

  it('rejects a declared body above the hard byte budget before parsing', async () => {
    const doFetch = vi.fn(async () => new Response(new ReadableStream(), {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    }))

    await expect(new Protocol2VaultClient(doFetch, API).listVaults(TOKEN))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('sends frozen protocol headers and a bounded snapshot page size', async () => {
    const doFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Palladin-Vault-Protocol')).toBe('2')
      expect(headers.get('X-Palladin-Sync-Policy')).toBe('1')
      expect(JSON.parse(String(init?.body))).toEqual({ vaultId: VAULT_ID, cursor: null, pageSize: 100 })
      return json({ snapshotBaseSequence: '0', items: [], nextCursor: null })
    })

    await expect(new Protocol2VaultClient(doFetch, API).snapshot(TOKEN, VAULT_ID, null))
      .resolves.toEqual({ snapshotBaseSequence: '0', items: [], nextCursor: null })
  })

  it('fails closed on unknown response fields', async () => {
    const doFetch = vi.fn(async () => json({ vaults: [], total: 0, plaintextName: 'must-not-pass' }))

    await expect(new Protocol2VaultClient(doFetch, API).listVaults(TOKEN))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('maps a valid retention-floor conflict to reset-required', async () => {
    const doFetch = vi.fn(async () => json({
      outcome: 'resetRequired',
      currentSequence: '10',
      minRetainedSequence: '4',
      newSnapshotRequired: true,
    }, 409))

    await expect(new Protocol2VaultClient(doFetch, API).delta(TOKEN, VAULT_ID, '1', null))
      .rejects.toBeInstanceOf(Protocol2ResetRequiredError)
  })
})
