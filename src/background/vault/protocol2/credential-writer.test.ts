import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberSecretV1 } from '@palladin/crypto'
import { createCapturedCredentialSecret } from '@palladin/crypto'
import { Protocol2CredentialWriter } from './credential-writer'
import type { CredentialWriterDeps } from './credential-writer'
import type { CredentialWriteTarget } from '../../capture/credential-coordinator'
import type { EntryGrantContext } from './grant-context'

const cryptoMocks = vi.hoisted(() => ({
  openVaultProjection: vi.fn(), openCurrentMemberSecret: vi.fn(), openVaultDerivedEnvelope: vi.fn(),
  sealCanonicalCredentialEntry: vi.fn(), buildCanonicalGrantEnvelope: vi.fn(),
  buildCanonicalScriptExecutionManifest: vi.fn(), sealCanonicalScriptExecutionPackage: vi.fn(), wipe: vi.fn(),
}))
vi.mock('@palladin/crypto', async (original) => ({ ...await original<typeof import('@palladin/crypto')>(), ...cryptoMocks }))

const VAULT = '11111111-1111-4111-8111-111111111111'
const ENTRY = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const SCRIPT = '55555555-5555-4555-8555-555555555555'
const url = 'https://accounts.example.com/login'
const credential = { kind: 'password-change' as const, username: 'alice', password: 'new-pass', previousPassword: 'old-pass' }
const secret = createCapturedCredentialSecret({ label: 'Alice', username: 'alice', password: 'old-pass',
  url: 'https://accounts.example.com', urlDomain: 'accounts.example.com' })
const target: Extract<CredentialWriteTarget, { action: 'update' }> = {
  action: 'update', vaultId: VAULT, entryId: ENTRY, revision: '4', label: 'Alice', vaultLabel: 'Personal',
  exactAccount: true, previousPasswordMatches: true,
}
const detail = { organizationId: ORG, vaultId: VAULT, id: ENTRY, state: 'active', currentRevision: '4',
  memberIndexRevision: '4', agentDiscoveryRevisionHighWatermark: '2', currentKeyVersion: 4,
  deliveryPolicy: 'injectOnly', entryKey: {}, memberSecret: {} }
const grant: EntryGrantContext = {
  id: '66666666-6666-4666-8666-666666666666', vaultId: VAULT, type: 'granular',
  agentId: '77777777-7777-4777-8777-777777777777', agentAccessEpoch: 2,
  agentPublicKey: 'AQ==', recipientAgentKeyVersion: 3, methods: 'exec, inject', entryId: ENTRY,
  entryScopes: [{ entryId: ENTRY, fieldIds: ['credential.password', 'credential.notes'], grantEnvelopeRevision: '8', grantKeyVersion: 2 }],
  scriptScopes: [], scriptPackageRevision: null, expiresAt: '2030-01-01T00:00:00Z', queryLimit: 20, queryCount: 3,
}

describe('captured Credential canonical writer', () => {
  let writer: Protocol2CredentialWriter
  let privateKey: Uint8Array | null
  const client = {
    listVaults: vi.fn(), getVault: vi.fn(), getEntry: vi.fn(), getActiveGrants: vi.fn(),
    issueEntryCreationChallenge: vi.fn(), createEntry: vi.fn(), updateEntry: vi.fn(),
  }
  const data = { refresh: vi.fn(), getMetadata: vi.fn() }
  const canWrite = vi.fn()
  const authorized = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    privateKey = new Uint8Array(32).fill(3)
    client.listVaults.mockResolvedValue([{ id: VAULT }])
    client.getVault.mockResolvedValue({ id: VAULT, organizationId: ORG, isDefault: true,
      currentKeyEpoch: { vaultKeyVersion: 1, vdkVersion: 1, manifestSigningKeyVersion: 2 },
      memberKeyGeneration: 1, discoveryKey: {}, vaultPrivateKeys: [{ descriptor: { purpose: 4, keyVersion: 2 } }] })
    client.getEntry.mockResolvedValue(detail)
    client.getActiveGrants.mockResolvedValue([])
    client.issueEntryCreationChallenge.mockResolvedValue(ENTRY)
    client.createEntry.mockResolvedValue({ id: ENTRY, currentRevision: '1' })
    client.updateEntry.mockResolvedValue({ currentRevision: '5' })
    data.refresh.mockResolvedValue([{ vaultId: VAULT, id: ENTRY, type: 1, urlDomain: 'accounts.example.com', username: 'alice' }])
    cryptoMocks.openVaultProjection.mockResolvedValue({ vaultKey: new Uint8Array(32).fill(1), metadata: { name: 'Personal' } })
    cryptoMocks.openVaultDerivedEnvelope.mockResolvedValue(new Uint8Array(32).fill(2))
    cryptoMocks.openCurrentMemberSecret.mockResolvedValue(secret)
    cryptoMocks.sealCanonicalCredentialEntry.mockResolvedValue({ entryKey: {}, memberSecret: {}, memberIndex: {}, agentDiscovery: {} })
    cryptoMocks.buildCanonicalGrantEnvelope.mockResolvedValue({ ciphertext: 'grant-envelope' })
    cryptoMocks.buildCanonicalScriptExecutionManifest.mockReturnValue({ contractVersion: 1 })
    cryptoMocks.sealCanonicalScriptExecutionPackage.mockResolvedValue({ ciphertext: 'script-package' })
    canWrite.mockResolvedValue(true)
    authorized.mockResolvedValue(true)
    writer = new Protocol2CredentialWriter({
      client, data, canWrite, session: { getUserId: async () => USER, getPrivateKey: () => privateKey,
        getAccessToken: async () => 'token', refreshAccessToken: async () => 'refreshed' },
    } as unknown as CredentialWriterDeps)
  })

  it('suggests exactly matched account updates, but registration defaults to Personal', async () => {
    expect((await writer.choices(credential, url)).defaultIndex).toBe(1)
    expect((await writer.choices({ ...credential, kind: 'registration', previousPassword: null }, url)).defaultIndex).toBe(0)
  })
  it('defaults ambiguous or absent matches to Personal and suppresses identical credentials', async () => {
    const entries = await data.refresh()
    data.refresh.mockResolvedValue([...entries, { ...entries[0], id: ENTRY }])
    expect((await writer.choices(credential, url)).defaultIndex).toBe(0)
    expect((await writer.choices({ ...credential, username: 'bob' }, url)).defaultIndex).toBe(0)
    expect((await writer.choices({ ...credential, password: 'old-pass' }, url)).identical).toBe(true)
  })
  it('does not offer writable vaults to read-only accounts', async () => {
    canWrite.mockResolvedValue(false)
    expect(await writer.choices(credential, url)).toEqual({ identical: false, targets: [], defaultIndex: null })
    expect(client.listVaults).not.toHaveBeenCalled()
  })
  it('creates with canonical defaults in the selected vault without FULL per-entry fan-out', async () => {
    const result = await writer.save(credential, url,
      { action: 'create', vaultId: VAULT, label: 'Personal', vaultLabel: 'Personal' }, authorized)
    expect(result).toEqual({ action: 'created', revision: '1' })
    const next = cryptoMocks.sealCanonicalCredentialEntry.mock.calls[0]![1] as MemberSecretV1
    expect(next).toMatchObject({ discoverable: true, agentFieldAccess: { 'credential.password': 'onGrantValue' },
      content: { password: 'new-pass', username: 'alice' } })
    expect(client.getActiveGrants).not.toHaveBeenCalled()
    expect(JSON.stringify(client.createEntry.mock.calls)).not.toContain('new-pass')
  })
  it('preserves all non-password fields, visibility policy, delivery policy and revision fences', async () => {
    const original = { ...secret, description: 'preserve me', content: { ...secret.content, notes: 'keep notes' } }
    cryptoMocks.openCurrentMemberSecret.mockResolvedValue(original)
    await writer.save(credential, url, target, authorized)
    expect(cryptoMocks.sealCanonicalCredentialEntry.mock.calls[0]![1]).toEqual({ ...original,
      content: { ...original.content, password: 'new-pass' } })
    expect(client.updateEntry.mock.calls[0]![1]).toMatchObject({ baseRevision: '4', deliveryPolicy: 'injectOnly' })
    expect(cryptoMocks.sealCanonicalCredentialEntry.mock.calls[0]![0]).toMatchObject({ revision: '5', entryKeyVersion: 5 })
  })
  it('atomically replaces GRANULAR envelopes while preserving scope and ignoring FULL fan-out', async () => {
    client.getActiveGrants.mockResolvedValue([{ ...grant, type: 'full' }, grant])
    await writer.save(credential, url, target, authorized)
    expect(cryptoMocks.buildCanonicalGrantEnvelope).toHaveBeenCalledTimes(1)
    expect(cryptoMocks.buildCanonicalGrantEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      approvedFieldIds: ['credential.password', 'notes'], approvedMethods: 6, deliveryPolicy: 2,
      entryRevision: '5', grantEnvelopeRevision: '9', grantKeyVersion: 3, recipientKeyVersion: 3, remainingUses: 17,
    }))
    expect(client.updateEntry.mock.calls[0]![1].grantEnvelopes).toEqual([{ ciphertext: 'grant-envelope' }])
  })
  it('rebuilds a complete dependent ScriptExecution package with the updated Credential revision', async () => {
    client.getActiveGrants.mockResolvedValue([{ ...grant, type: 'scriptExecution', scriptPackageRevision: '3',
      scriptScopes: [{ entryId: SCRIPT, entryRevision: '1', isScript: true }, { entryId: ENTRY, entryRevision: '4', isScript: false }] }])
    const scriptSecret: MemberSecretV1 = { ...secret, entryType: 'script', content: {
      source: 'echo ok', interpreter: 'bash', refs: [{ env: 'PASSWORD', vaultId: VAULT, entryId: ENTRY, fieldId: 'credential.password' }],
      notes: null, customFields: [],
    } }
    client.getEntry.mockImplementation(async (_token, _vault, id) => ({ ...detail, id }))
    cryptoMocks.openCurrentMemberSecret.mockResolvedValueOnce(secret).mockResolvedValueOnce(scriptSecret)
    await writer.save(credential, url, target, authorized)
    expect(cryptoMocks.buildCanonicalScriptExecutionManifest).toHaveBeenCalledWith(expect.objectContaining({ referenceRevisions: { [ENTRY]: '5' } }))
    expect(cryptoMocks.sealCanonicalScriptExecutionPackage).toHaveBeenCalledWith(expect.objectContaining({
      packageRevision: '4', entries: [expect.objectContaining({ entryId: ENTRY, entryRevision: '5' })],
    }))
    expect(client.updateEntry.mock.calls[0]![1].scriptGrantPackages).toEqual([{ ciphertext: 'script-package' }])
  })
  it.each(['missing-recipient', 'field-scope', 'methods', 'vault-scope', 'builder-error'])(
    'fails before any mutation for invalid grant material: %s', async (scenario) => {
      let nextGrant = grant
      if (scenario === 'missing-recipient') nextGrant = { ...grant, agentPublicKey: null }
      if (scenario === 'field-scope') nextGrant = { ...grant, entryScopes: [{ ...grant.entryScopes[0]!, fieldIds: ['credential.urlDomain'] }] }
      if (scenario === 'methods') nextGrant = { ...grant, methods: 'unregistered' }
      if (scenario === 'vault-scope') nextGrant = { ...grant, vaultId: 'other' }
      if (scenario === 'builder-error') cryptoMocks.buildCanonicalGrantEnvelope.mockRejectedValue(new Error('invalid'))
      client.getActiveGrants.mockResolvedValue([nextGrant])
      await expect(writer.save(credential, url, target, authorized)).rejects.toThrow()
      expect(client.updateEntry).not.toHaveBeenCalled()
      expect(cryptoMocks.wipe).toHaveBeenCalledTimes(2)
    },
  )
  it.each(['revision', 'account', 'host', 'locked'])(
    'rejects a stale target before committing: %s', async (scenario) => {
      if (scenario === 'revision') client.getEntry.mockResolvedValue({ ...detail, currentRevision: '5' })
      if (scenario === 'account') cryptoMocks.openCurrentMemberSecret.mockResolvedValue({ ...secret, content: { ...secret.content, username: 'bob' } })
      if (scenario === 'host') cryptoMocks.openCurrentMemberSecret.mockResolvedValue({ ...secret, content: { ...secret.content, urlDomain: 'evil.example.com' } })
      if (scenario === 'locked') authorized.mockResolvedValueOnce(true).mockResolvedValue(false)
      await expect(writer.save(credential, url, target, authorized)).rejects.toThrow()
      expect(client.updateEntry).not.toHaveBeenCalled()
    },
  )
  it('does not turn a refresh failure after commit into a retryable write', async () => {
    data.refresh.mockRejectedValue(new Error('offline'))
    expect(await writer.save(credential, url, target, authorized)).toEqual({ action: 'updated', revision: '5' })
    expect(client.updateEntry).toHaveBeenCalledTimes(1)
  })
  it.each(['create', 'update'] as const)('acknowledges committed %s and wipes keys without waiting for refresh', async (action) => {
    let finishRefresh!: () => void
    let refreshStarted!: () => void
    const started = new Promise<void>((resolve) => { refreshStarted = resolve })
    data.refresh.mockImplementation(() => {
      refreshStarted()
      return new Promise<void>((resolve) => { finishRefresh = resolve })
    })
    const selected: CredentialWriteTarget = action === 'update' ? target
      : { action: 'create', vaultId: VAULT, label: 'Personal', vaultLabel: 'Personal' }
    let result: { action: 'created' | 'updated'; revision: string } | undefined
    const saving = writer.save(credential, url, selected, authorized).then((value) => { result = value })
    try {
      await started
      // Flush the write's continuations while the independently controlled refresh remains pending.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(result).toEqual(action === 'create' ? { action: 'created', revision: '1' }
        : { action: 'updated', revision: '5' })
      expect(cryptoMocks.wipe).toHaveBeenCalledTimes(2)
      expect(action === 'create' ? client.createEntry : client.updateEntry).toHaveBeenCalledTimes(1)
    } finally {
      finishRefresh()
      await saving
    }
  })
})
