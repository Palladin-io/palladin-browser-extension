import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as crypto from '@palladin/crypto'

export async function createCaptureGrantFixture(organizationId, vaultId) {
  const sodium = await crypto.loadSodium()
  const agent = sodium.crypto_box_keypair()
  const agentId = randomUUID()
  const publicKey = crypto.toBase64(agent.publicKey)
  const fingerprint = await crypto.computeVaultKeyFingerprint(agent.publicKey, crypto.VAULT_KEY_KIND.agentX25519)
  const common = { vaultId, agentId, agentAccessEpoch: 1, agentPublicKey: publicKey,
    recipientAgentKeyVersion: 1, methods: 'get, exec, inject', entryId: null,
    entryScopes: [], scriptScopes: [], scriptPackageRevision: null, expiresAt: null, queryLimit: null, queryCount: 0 }
  const grants = [{ ...common, id: randomUUID(), type: 'full' }]
  return {
    grants,
    addGranular(entryId) {
      const grant = { ...common, id: randomUUID(), type: 'granular', entryId,
        methods: 'inject', queryLimit: 10, queryCount: 2,
        entryScopes: [{ entryId, fieldIds: ['credential.password'], grantEnvelopeRevision: '1', grantKeyVersion: 1 }] }
      grants.push(grant)
      return grant
    },
    addScript(scriptEntryId, entryId) {
      const grant = { ...common, id: randomUUID(), type: 'scriptExecution', methods: 'exec',
        scriptPackageRevision: '1', scriptScopes: [
          { entryId: scriptEntryId, entryRevision: '1', isScript: true },
          { entryId, entryRevision: '1', isScript: false },
        ] }
      grants.push(grant)
      return grant
    },
    async verifyScript(sealed, grant, vault, entryId, expectedPassword) {
      const signingKey = crypto.fromBase64Url(vault.vaultManifestSigningPublicKey.encodedPublicKey)
      let opened
      try {
        opened = await crypto.openScriptExecutionPackage(sealed, agent.privateKey, {
          organizationId, vaultId, grantId: grant.id, agentId, agentAccessEpoch: 1,
          scriptEntryId: grant.scriptScopes[0].entryId, scriptRevision: '1', packageRevision: '2',
          recipientAgentKeyVersion: 1, vaultSigningKeyVersion: 1,
          vaultSigningKeyFingerprint: vault.vaultManifestSigningPublicKey.fingerprint,
          vaultSigningPublicKey: signingKey,
        })
        assert.equal(opened.entries.length, 1)
        assert.equal(opened.entries[0].entryId, entryId)
        assert.equal(opened.entries[0].entryRevision, '2')
        assert.deepEqual(crypto.parseGrantPayload(opened.entries[0].encodedGrantPayload).fields, [
          { id: 'credential.password', kind: 'concealed', mode: 'value', value: expectedPassword },
          { id: 'credential.username', kind: 'text', mode: 'value', value: 'grant-user' },
        ])
        assert.deepEqual(opened.manifest.references.map((ref) => ref.fieldId).sort(), ['credential.password', 'credential.username'])
      } finally {
        crypto.wipe(signingKey)
        for (const entry of opened?.entries ?? []) crypto.wipe(entry.encodedGrantPayload)
      }
    },
    async verifyGranular(envelope, grant, entryRevision, expectedPassword) {
      assert.deepEqual(envelope.fieldIds, ['credential.password'])
      const commitment = await crypto.computeFieldSetCommitment(['credential.password'])
      const expected = { protocolVersion: 2, cryptoSuiteId: crypto.VAULT_XCHACHA20_POLY1305_V1,
        purpose: crypto.ENVELOPE_PURPOSE.grant, organizationId, vaultId, entryId: grant.entryId,
        grantOrRequestId: grant.id, agentId, resourceRevision: 2n, keyVersion: 2, memberKeyGeneration: 1 }
      const aad = crypto.encodeDeliveryBoundGrantAad(expected, { entryRevision: BigInt(entryRevision),
        wrapperSuiteId: crypto.X25519_SEALED_BOX_V1, recipientKeyVersion: 1,
        recipientKeyFingerprint: fingerprint, methods: 4, deliveryPolicy: 0,
        fieldSetCommitment: commitment, remainingUses: 8 })
      const parentHash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', aad))
      let dek, key, plaintext
      try {
        dek = await crypto.openKeyFromX25519Recipient(crypto.fromBase64Url(envelope.wrappedGrantDek.encodedSealedKeyPackage),
          agent.publicKey, agent.privateKey, { protocolVersion: 2, wrapperSuiteId: crypto.X25519_SEALED_BOX_V1,
            purpose: crypto.WRAPPER_PURPOSE.grantDek, organizationId, vaultId, entryId: grant.entryId,
            grantOrRequestId: grant.id, agentId, resourceRevision: 2n, wrappedKeyVersion: 2, memberKeyGeneration: 1,
            recipientKeyKind: crypto.VAULT_KEY_KIND.agentX25519, recipientKeyVersion: 1,
            recipientFingerprint: fingerprint, parentDescriptorHash: parentHash })
        const { resourceRevision, ...kdf } = expected
        void resourceRevision
        key = await crypto.deriveVaultSubkey(dek, kdf)
        const suite = crypto.requireCryptoSuite(crypto.VAULT_XCHACHA20_POLY1305_V1)
        plaintext = await suite.open({ key, aad, payload: suite.validateEncodedPayload(crypto.fromBase64Url(envelope.encodedSuitePayload)) })
        assert.deepEqual(crypto.parseGrantPayload(plaintext), { schema: 'palladin.grant-payload.v1', entryType: 'credential',
          fields: [{ id: 'credential.password', kind: 'concealed', mode: 'value', value: expectedPassword }] })
      } finally {
        for (const bytes of [dek, key, plaintext, commitment, parentHash]) if (bytes) crypto.wipe(bytes)
      }
    },
    close() { crypto.wipe(agent.privateKey); crypto.wipe(fingerprint) },
  }
}
