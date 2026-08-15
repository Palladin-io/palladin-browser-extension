import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemberSyncCache } from './cache'
import {
  Protocol2MutationConflictError,
  type Protocol2VaultClient,
} from './client'
import type { EncryptedVaultSummary, MemberSyncItem } from './contracts'
import { Protocol2VaultDataService, type Protocol2SessionAccessor } from './service'

const cryptoMocks = vi.hoisted(() => ({
  openMemberIndex: vi.fn(),
  openMemberSecret: vi.fn(),
  openMemberVaultKey: vi.fn(async () => new Uint8Array(32).fill(1)),
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

const vault = {
  id: VAULT_ID,
  isDefault: true,
  memberSequence: '1',
  memberKeyGeneration: 1,
  currentKeyEpoch: { vaultKeyVersion: 1, vdkVersion: 1 },
  memberVaultKey: {
    wrappedVaultKey: {
      descriptor: { scope: { organizationId: USER_ID } },
    },
  },
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
  entryKey: {},
  memberIndex: {},
} as unknown as MemberSyncItem

function material() {
  return {
    entryKey: { descriptor: { purpose: 8 }, encodedSuitePayload: 'key' },
    memberIndex: { descriptor: { purpose: 5 }, encodedSuitePayload: 'index' },
    memberSecret: { descriptor: { purpose: 6 }, encodedSuitePayload: 'secret' },
    agentDiscovery: null,
  }
}

function harness(items: MemberSyncItem[] = []) {
  const client = {
    listVaults: vi.fn(async () => [vault]),
    delta: vi.fn(async () => ({
      deltaUpperBound: '1',
      appliedThroughSequence: '1',
      items: [],
      continuationCursor: null,
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
    getActiveState: vi.fn(async () => ({
      namespace: 'active',
      appliedThroughSequence: '1',
      vault,
    })),
    readActiveItemPage: vi.fn(async () => ({ items, nextEntryId: null })),
    applyActiveDeltaPage: vi.fn(async () => undefined),
    removeMissingVaults: vi.fn(async () => undefined),
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
  })
  return { service, client, cache }
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
    urlDomain: 'example.com',
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
      urlDomain: 'example.com',
      totp: null,
      notes: null,
      customFields: [],
    },
  })
})

describe('Protocol2VaultDataService canonical password capture', () => {
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
        urlDomain: 'example.com',
      },
    })
    expect(client.createEntry).toHaveBeenCalledWith('token', expect.objectContaining({
      vaultId: VAULT_ID,
      entryId: ENTRY_ID,
      grantEnvelopes: [],
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
      grantEnvelopes: [],
    }))
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
    const second = { ...head, entryId: '44444444-4444-4444-8444-444444444444' }
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

    await expect(service.saveCreditCard({
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
})
