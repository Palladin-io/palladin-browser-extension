import { describe, expect, it, vi } from 'vitest'

import {
  Protocol2MutationConflictError,
  Protocol2ResetRequiredError,
  Protocol2VaultClient,
} from './client'

const API = 'https://api.test'
const TOKEN = 'opaque-access-token'
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const VAULT_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function scope(memberId: string | null = null) {
  return {
    organizationId: ORGANIZATION_ID,
    vaultId: VAULT_ID,
    entryId: null,
    grantOrRequestId: null,
    agentId: null,
    memberId,
  }
}

function vaultEnvelope(
  purpose: 'memberVaultMetadata' | 'vaultDiscoveryKey' | 'vaultAgentMessagePrivateKey' | 'vaultManifestSigningPrivateKey',
  keyVersion: number,
  binding: Record<string, never> | { wrappingVaultKeyVersion: number },
) {
  return {
    descriptor: {
      protocolVersion: 2,
      cryptoSuiteId: 'palladin-vault-xchacha-v1',
      purpose,
      scope: scope(),
      resourceRevision: '1',
      keyVersion,
      memberKeyGeneration: 1,
      binding,
    },
    encodedSuitePayload: 'encoded-payload',
  }
}

function vaultDetail(metadataRevision: unknown = '1') {
  return {
    id: VAULT_ID,
    organizationId: ORGANIZATION_ID,
    isDefault: true,
    protocolVersion: 2,
    memberSequence: '1',
    discoverySequence: '1',
    metadataRevision,
    memberKeyGeneration: 1,
    currentKeyEpoch: {
      vaultKeyVersion: 1,
      vdkVersion: 1,
      agentMessageKeyVersion: 1,
      manifestSigningKeyVersion: 1,
    },
    memberVaultMetadata: vaultEnvelope('memberVaultMetadata', 1, {}),
    memberVaultKey: {
      wrappedVaultKey: {
        descriptor: {
          protocolVersion: 2,
          wrapperSuiteId: 'palladin-x25519-sealed-box-v1',
          purpose: 'memberVaultKey',
          scope: scope(MEMBER_ID),
          resourceRevision: '1',
          wrappedKeyVersion: 1,
          memberKeyGeneration: 1,
          recipientKeyKind: 'memberX25519',
          recipientKeyVersion: 1,
          recipientFingerprint: 'recipient-fingerprint',
          parentDescriptorHash: null,
        },
        encodedSealedKeyPackage: 'sealed-key-package',
      },
    },
    discoveryKey: vaultEnvelope('vaultDiscoveryKey', 1, { wrappingVaultKeyVersion: 1 }),
    vaultPrivateKeys: [
      vaultEnvelope('vaultAgentMessagePrivateKey', 1, { wrappingVaultKeyVersion: 1 }),
      vaultEnvelope('vaultManifestSigningPrivateKey', 1, { wrappingVaultKeyVersion: 1 }),
    ],
    vaultAgentMessagePublicKey: {
      protocolVersion: 2,
      schemeId: 'palladin-x25519-v1',
      keyKind: 'agentMessageX25519',
      keyVersion: 1,
      encodedPublicKey: 'agent-message-public-key',
      fingerprint: 'agent-message-fingerprint',
    },
    vaultManifestSigningPublicKey: {
      protocolVersion: 2,
      schemeId: 'palladin-ed25519-v1',
      keyKind: 'manifestSigningEd25519',
      keyVersion: 1,
      encodedPublicKey: 'manifest-signing-public-key',
      fingerprint: 'manifest-signing-fingerprint',
    },
    createdAt: '2026-08-16T12:00:00Z',
    updatedAt: '2026-08-16T12:00:00Z',
    memberCount: 1,
    entryCount: 0,
    activeGrantCount: 0,
  }
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

  it('accepts the strict GET detail with authoritative top-level metadata revision', async () => {
    const client = new Protocol2VaultClient(async () => json(vaultDetail()), API)

    await expect(client.getVault(TOKEN, VAULT_ID)).resolves.toMatchObject({
      id: VAULT_ID,
      organizationId: ORGANIZATION_ID,
      metadataRevision: '1',
    })
  })

  it.each([
    { name: 'missing', revision: undefined },
    { name: 'a JSON number', revision: 1 },
    { name: 'non-canonical decimal', revision: '01' },
    { name: 'u64 overflow', revision: '18446744073709551616' },
  ])('fails closed when GET metadataRevision is $name', async ({ revision }) => {
    const body = vaultDetail(revision)
    if (revision === undefined) delete (body as { metadataRevision?: unknown }).metadataRevision
    const client = new Protocol2VaultClient(async () => json(body), API)

    await expect(client.getVault(TOKEN, VAULT_ID)).rejects.toMatchObject({ code: 'network' })
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

  it('uses a server-issued Entry id and sends the canonical create body unchanged', async () => {
    const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/creation-challenges')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ vaultId: VAULT_ID, count: 1 })
        return json({
          items: [{
            entryId: '33333333-3333-4333-8333-333333333333',
            expiresAt: '2026-08-16T12:00:00Z',
          }],
        })
      }
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        vaultId: VAULT_ID,
        entryId: '33333333-3333-4333-8333-333333333333',
        grantEnvelopes: [],
      })
      return json({ id: '33333333-3333-4333-8333-333333333333', currentRevision: '1' }, 201)
    })
    const client = new Protocol2VaultClient(doFetch, API)
    const entryId = await client.issueEntryCreationChallenge(TOKEN, VAULT_ID)
    await expect(client.createEntry(TOKEN, {
      vaultId: VAULT_ID,
      entryId,
      entryKey: {} as never,
      memberIndex: {} as never,
      memberSecret: {} as never,
      agentDiscovery: null,
      grantEnvelopes: [],
    })).resolves.toMatchObject({ currentRevision: '1' })
  })

  it('keeps a canonical mutation conflict distinct so the UI never claims it saved', async () => {
    const client = new Protocol2VaultClient(async () => json({}, 409), API)
    await expect(client.updateEntry(TOKEN, {
      vaultId: VAULT_ID,
      entryId: '33333333-3333-4333-8333-333333333333',
      baseRevision: '1',
      newEntryKey: {} as never,
      memberSecret: {} as never,
      memberIndex: {} as never,
      agentDiscoveryChanged: false,
      agentDiscovery: null,
      grantEnvelopes: [],
    })).rejects.toBeInstanceOf(Protocol2MutationConflictError)
  })
})
