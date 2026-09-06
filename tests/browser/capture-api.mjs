import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import * as crypto from '@palladin/crypto'
import { createCaptureGrantFixture } from './capture-grants.mjs'

// Disposable provider fixture: real client crypto, synthetic identities, no production service.
export async function createCaptureApi() {
  const userId = randomUUID()
  const organizationId = randomUUID()
  const email = 'capture-user@example.test'
  const password = 'Synthetic master password for browser acceptance 373!'
  const sodium = await crypto.loadSodium()
  const member = sodium.crypto_box_keypair()
  const salt = await crypto.randomBytes(16)
  const identity = await crypto.deriveIdentityV1(password, userId, salt)
  const encryptedPrivateKey = crypto.toBase64Url(await crypto.encryptWithKey(member.privateKey, identity.masterKey))
  const expectedAuth = crypto.toBase64Url(identity.authCredential)
  crypto.wipe(identity.masterKey)
  crypto.wipe(identity.authCredential)
  const recipientFingerprint = crypto.toBase64Url(await crypto.computeVaultKeyFingerprint(member.publicKey, 5))
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ sub: userId, permissions: '8', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.unsigned`
  const auth = { accessToken, refreshToken: 'synthetic-refresh-token', userId, isOnboarded: true, emailVerified: true }
  const bootstrap = { accountId: userId, profileId: crypto.IDENTITY_KDF_PROFILE_ID,
    securityVersion: crypto.IDENTITY_SECURITY_VERSION, kdfSalt: crypto.toBase64Url(salt), ...crypto.IDENTITY_KDF_PROFILE }
  const vaults = []
  const writes = []
  const requests = []
  const errors = []
  let rejectNextUpdate = false
  for (const name of ['Personal', 'Team']) {
    const id = randomUUID()
    const vaultKey = await crypto.randomBytes(32)
    const discoveryKey = await crypto.randomBytes(32)
    const scope = { organizationId, vaultId: id }
    const memberVaultKey = { wrappedVaultKey: { descriptor: {
      protocolVersion: 2, wrapperSuiteId: crypto.X25519_SEALED_BOX_V1, purpose: 1,
      scope: { ...scope, memberId: userId }, resourceRevision: '1', wrappedKeyVersion: 1,
      memberKeyGeneration: 1, recipientKeyKind: 5, recipientKeyVersion: 1,
      recipientFingerprint, parentDescriptorHash: null,
    }, encodedSealedKeyPackage: '' } }
    memberVaultKey.wrappedVaultKey.encodedSealedKeyPackage = crypto.toBase64Url(await crypto.sealKeyToX25519Recipient(
      vaultKey, member.publicKey, crypto.wrapperContextFromMemberVaultKey(memberVaultKey)))
    const seal = async (purpose, bytes) => {
      const descriptor = { protocolVersion: 2, cryptoSuiteId: crypto.VAULT_XCHACHA20_POLY1305_V1,
        purpose, scope, resourceRevision: '1', keyVersion: 1, memberKeyGeneration: 1,
        binding: purpose === 1 ? {} : { wrappingVaultKeyVersion: 1 } }
      const key = await crypto.deriveVaultSubkey(vaultKey, { protocolVersion: 2,
        cryptoSuiteId: crypto.VAULT_XCHACHA20_POLY1305_V1, purpose, organizationId,
        vaultId: id, keyVersion: 1, memberKeyGeneration: 1 })
      try { return await crypto.sealVaultEnvelope(descriptor, bytes, key, purpose === 1 ? undefined : { wrappingVkVersion: 1 }) }
      finally { crypto.wipe(key) }
    }
    const message = sodium.crypto_box_keypair()
    const signing = sodium.crypto_sign_keypair()
    const stamp = new Date().toISOString()
    const publicKey = async (bytes, kind, keyKind, schemeId) => ({ protocolVersion: 2, schemeId,
      keyKind, keyVersion: 1, encodedPublicKey: crypto.toBase64Url(bytes),
      fingerprint: crypto.toBase64Url(await crypto.computeVaultKeyFingerprint(bytes, kind)) })
    const detail = {
      id, organizationId, isDefault: name === 'Personal', protocolVersion: 2, metadataRevision: '1',
      memberSequence: '1', discoverySequence: '1', memberKeyGeneration: 1,
      currentKeyEpoch: { vaultKeyVersion: 1, vdkVersion: 1, agentMessageKeyVersion: 1, manifestSigningKeyVersion: 1 },
      memberVaultMetadata: await seal(1, crypto.encodeMemberVaultMetadata({
        schema: 'palladin.member-vault-metadata.v1', name, description: null, icon: null, color: null, grantMode: 'granular' })),
      memberVaultKey, discoveryKey: await seal(2, discoveryKey),
      vaultPrivateKeys: [await seal(3, message.privateKey), await seal(4, signing.privateKey)],
      vaultAgentMessagePublicKey: await publicKey(message.publicKey, 4, 'agentMessageX25519', 'palladin-x25519-v1'),
      vaultManifestSigningPublicKey: await publicKey(signing.publicKey, 3, 'manifestSigningEd25519', 'palladin-ed25519-v1'),
      createdAt: stamp, updatedAt: stamp, memberCount: 1, entryCount: 0, activeGrantCount: 0,
    }
    crypto.wipe(message.privateKey)
    crypto.wipe(signing.privateKey)
    const grantFixture = await createCaptureGrantFixture(organizationId, id)
    vaults.push({ name, detail, vaultKey, discoveryKey, grantFixture, entries: new Map(), challenges: new Set() })
  }
  crypto.wipe(member.privateKey)
  const head = (entry) => ({ entryId: entry.id, kind: 'head', state: entry.state, updatedAt: entry.updatedAt,
    currentRevision: entry.currentRevision, memberIndexRevision: entry.memberIndexRevision,
    currentKeyVersion: entry.currentKeyVersion, entryKey: entry.entryKey, memberIndex: entry.memberIndex, memberSecret: entry.memberSecret })
  const accept = (vault, request, previous) => {
    const stamp = new Date().toISOString()
    const entryKey = previous ? request.newEntryKey : request.entryKey
    const agentDiscovery = previous && !request.agentDiscoveryChanged ? previous.agentDiscovery : request.agentDiscovery
    const entry = { organizationId, vaultId: vault.detail.id, id: request.entryId, state: 'active',
      currentRevision: request.memberSecret.descriptor.resourceRevision,
      memberIndexRevision: request.memberIndex.descriptor.resourceRevision,
      agentDiscoveryRevision: agentDiscovery?.descriptor.resourceRevision ?? null,
      agentDiscoveryRevisionHighWatermark: agentDiscovery?.descriptor.resourceRevision ?? '0',
      currentKeyVersion: entryKey.descriptor.keyVersion, deliveryPolicy: request.deliveryPolicy,
      createdAt: previous?.createdAt ?? stamp, createdBy: userId, updatedAt: stamp, updatedBy: userId,
      entryKey, memberIndex: request.memberIndex, memberSecret: request.memberSecret, agentDiscovery }
    vault.entries.set(entry.id, entry)
    vault.detail.memberSequence = (BigInt(vault.detail.memberSequence) + 1n).toString()
    vault.detail.entryCount = vault.entries.size
    return entry
  }
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(wire(value))) }
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const url = new URL(req.url, 'http://localhost')
      requests.push(`${req.method} ${url.pathname}`)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const request = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (url.pathname === '/api/auth/login/salt') return send(bootstrap)
      if (url.pathname === '/api/auth/login') {
        return request.email === email && request.authCredential === expectedAuth ? send(auth) : send(null, 401)
      }
      if (url.pathname === '/api/auth/refresh') return send(auth)
      if (url.pathname === '/api/account') return send({ userId, email, encryptedPrivateKey, kdf: {
        securityVersion: 1, minimumSecurityVersion: 1, profileId: crypto.IDENTITY_KDF_PROFILE_ID,
        kdfSalt: bootstrap.kdfSalt, credentialRevision: 1, privateKeyWrapRevision: 1, deviceWrapperMetadata: null } })
      if (url.pathname.startsWith('/hubs/')) return send(null, 404)
      if (req.headers.authorization !== `Bearer ${accessToken}`) return send(null, 401)
      if (url.pathname === '/api/vaults') return send({ total: vaults.length, vaults: vaults.map(({ detail }) => {
        const { organizationId: _org, metadataRevision: _rev, vaultAgentMessagePublicKey: _msg, vaultManifestSigningPublicKey: _sign, ...summary } = detail
        return summary
      }) })
      if (url.pathname === '/api/grants') return send({ items: vaults.find(({ detail }) => detail.id === url.searchParams.get('vaultId'))?.grantFixture.grants ?? [], nextCursor: null })
      const vault = vaults.find(({ detail }) => url.pathname.startsWith(`/api/vaults/${detail.id}`))
      if (!vault) return send(null, 404)
      const suffix = url.pathname.slice(`/api/vaults/${vault.detail.id}`.length)
      if (suffix === '') return send(vault.detail)
      if (suffix.includes('/sync/')) {
        const accessContext = { contextVersion: 1, principalId: userId, organizationId, organizationMembershipGeneration: '1',
          vaultId: vault.detail.id, memberId: userId, memberKeyGeneration: 1, vaultKeyVersion: 1,
          memberRecipientKeyVersion: 1, memberRecipientKeyFingerprint: recipientFingerprint,
          offlinePolicy: '24h', offlinePolicyVersion: 1, issuedAt: new Date().toISOString(),
          notAfter: new Date(Date.now() + 86400_000).toISOString() }
        const shared = { accessContext, memberVaultKey: vault.detail.memberVaultKey, items: [...vault.entries.values()].map(head) }
        return suffix.endsWith('/snapshot') ? send({ ...shared, snapshotBaseSequence: vault.detail.memberSequence, nextCursor: null })
          : send({ ...shared, deltaUpperBound: vault.detail.memberSequence, appliedThroughSequence: vault.detail.memberSequence, continuationCursor: null })
      }
      if (suffix === '/entries/creation-challenges') {
        const entryId = randomUUID()
        vault.challenges.add(entryId)
        return send({ items: [{ entryId, expiresAt: new Date(Date.now() + 60000).toISOString() }] })
      }
      if (req.method === 'POST' && suffix === '/entries') {
        assert(vault.challenges.delete(request.entryId))
        const entry = accept(vault, request)
        writes.push({ action: 'created', vaultId: vault.detail.id, entryId: entry.id, request })
        return send({ id: entry.id, currentRevision: entry.currentRevision })
      }
      const entry = vault.entries.get(suffix.slice('/entries/'.length))
      if (!entry) return send(null, 404)
      if (req.method === 'GET') return send(entry)
      if (req.method === 'PUT') {
        if (rejectNextUpdate) { rejectNextUpdate = false; return send(null, 409) }
        if (request.baseRevision !== entry.currentRevision) return send(null, 409)
        const updated = accept(vault, request, entry)
        writes.push({ action: 'updated', vaultId: vault.detail.id, entryId: entry.id, request })
        return send({ currentRevision: updated.currentRevision })
      }
      return send(null, 404)
    } catch { errors.push('Synthetic API contract failure'); return send(null, 500) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { email, password, vaults, writes, requests, errors, url: `http://localhost:${server.address().port}`,
    rejectNextUpdate() { rejectNextUpdate = true },
    async addScriptFor(write) {
      const vault = vaults.find(({ detail }) => detail.id === write.vaultId)
      const entryId = randomUUID()
      const secret = { schema: 'palladin.member-secret.v1', entryType: 'script', memberLabel: 'Dependent Script',
        agentLabel: 'Dependent Script', discoverable: true, description: 'Synthetic script for capture acceptance', icon: null, color: null,
        content: { source: 'printf ok', interpreter: 'sh', notes: null, customFields: [],
          execution: { contractVersion: 1, description: 'Synthetic script for capture acceptance', parameters: [], returnResultToAgent: false },
          refs: ['password', 'username'].map((field) => ({ env: `LOGIN_${field.toUpperCase()}`, vaultId: vault.detail.id,
            entryId: write.entryId, fieldId: `credential.${field}` })) },
        agentFieldAccess: { memberLabel: 'never', agentLabel: 'discovery', description: 'discovery', icon: 'never', color: 'never',
          entryType: 'discovery', notes: 'never', 'script.source': 'onGrantRuntime', 'script.interpreter': 'discovery', 'script.refs': 'onGrantRuntime' } }
      const material = await crypto.sealCanonicalEntry({ organizationId, vaultId: vault.detail.id, entryId, revision: '1',
        vaultKeyVersion: 1, vdkVersion: 1, memberKeyGeneration: 1 }, secret, vault.vaultKey, vault.discoveryKey, 1)
      accept(vault, { ...material, entryId, deliveryPolicy: 'standard' })
      return vault.grantFixture.addScript(entryId, write.entryId)
    },
    async decrypt(write) {
      const vault = vaults.find(({ detail }) => detail.id === write.vaultId)
      const entry = vault.entries.get(write.entryId)
      return crypto.openMemberSecret(entry.entryKey, entry.memberSecret, vault.vaultKey,
        { organizationId, vaultId: vault.detail.id, entryId: entry.id, revision: entry.currentRevision })
    },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      for (const vault of vaults) { crypto.wipe(vault.vaultKey); crypto.wipe(vault.discoveryKey); vault.grantFixture.close() } },
  }
}

const purposes = ['', 'memberVaultMetadata', 'vaultDiscoveryKey', 'vaultAgentMessagePrivateKey',
  'vaultManifestSigningPrivateKey', 'memberIndex', 'memberSecret', 'agentDiscovery', 'entryDekByVaultKey', 'encryptedReason', 'grantPayload']
function wire(value) {
  if (Array.isArray(value)) return value.map(wire)
  if (value === null || typeof value !== 'object') return value
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]))
  if ('scope' in value && 'purpose' in value) {
    out.scope = { entryId: null, grantOrRequestId: null, agentId: null, memberId: null, ...out.scope }
    out.purpose = value.wrapperSuiteId ? ({ 1: 'memberVaultKey', 4: 'grantDek' })[value.purpose] : purposes[value.purpose]
    if (value.wrapperSuiteId) out.recipientKeyKind = ({ 1: 'agentX25519', 5: 'memberX25519' })[value.recipientKeyKind]
    if (value.purpose === 6 && !value.wrapperSuiteId) out.binding.operation = ['', 'created', 'updated', 'archived', 'restored', 'deleted'][value.binding.operation]
  }
  return out
}
