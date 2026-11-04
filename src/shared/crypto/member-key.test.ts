import {
  computeRecipientFingerprint,
  generateRecipientKeyPair,
  KEY_WRAPPER_SUITE,
  openMemberVaultKey,
  RECIPIENT_KEY_KIND,
  sealKey,
  toBase64Url,
  type RecipientKeyPair,
} from '@palladin/crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import { memberVaultKeyEnvelopeSchema } from '../../background/vault/protocol2/vault-key-material-schema'
import { memberRecipient } from './member-key'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const VAULT_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const VAULT_KEY = new Uint8Array(32).fill(7)

/** The member Vault key wrapper as the backend sends it: registry names, algorithm only in wrapperSuiteId. */
async function wireEnvelope(recipient: RecipientKeyPair) {
  const fingerprint = toBase64Url(computeRecipientFingerprint(
    recipient.keySuiteId, RECIPIENT_KEY_KIND.memberEncryption, recipient.publicKey))
  const wire = {
    protocolVersion: 2,
    wrapperSuiteId: recipient.keySuiteId as string,
    purpose: 'memberVaultKey',
    scope: { organizationId: ORGANIZATION_ID, vaultId: VAULT_ID, entryId: null, grantOrRequestId: null, agentId: null, memberId: MEMBER_ID },
    resourceRevision: '3',
    wrappedKeyVersion: 3,
    memberKeyGeneration: 2,
    recipientKeyKind: 'memberEncryption',
    recipientKeyVersion: 4,
    recipientFingerprint: fingerprint,
    parentDescriptorHash: null,
  }
  const descriptor = { ...wire, purpose: 1, recipientKeyKind: RECIPIENT_KEY_KIND.memberEncryption }
  const encodedSealedKeyPackage = await sealKey(descriptor, VAULT_KEY, {
    keySuiteId: recipient.keySuiteId, keyKind: RECIPIENT_KEY_KIND.memberEncryption, keyVersion: 4, publicKey: recipient.publicKey,
  })
  return { wrappedVaultKey: { descriptor: wire, encodedSealedKeyPackage } }
}

function parse(wire: unknown) {
  return memberVaultKeyEnvelopeSchema.parse(wire)
}

describe('member Vault key through the neutral key wrapper', () => {
  let member: RecipientKeyPair
  let envelope: Awaited<ReturnType<typeof wireEnvelope>>

  beforeAll(async () => {
    member = await generateRecipientKeyPair()
    envelope = await wireEnvelope(member)
  })

  it('opens a post-quantum member envelope with the Identity v2 member key', async () => {
    const recipient = await memberRecipient({ memberKeySuiteId: KEY_WRAPPER_SUITE.active, memberKeyVersion: 4, privateKey: member.privateKey })

    await expect(openMemberVaultKey(parse(envelope), recipient)).resolves.toEqual(VAULT_KEY)
  })

  it('fails closed for an envelope addressed to another member key', async () => {
    const other = await generateRecipientKeyPair()
    const recipient = await memberRecipient({ memberKeySuiteId: KEY_WRAPPER_SUITE.active, memberKeyVersion: 4, privateKey: other.privateKey })

    await expect(openMemberVaultKey(parse(envelope), recipient)).rejects.toMatchObject({ code: 'recipient-mismatch' })
  })

  it('fails closed when the envelope names another member key version', async () => {
    const recipient = await memberRecipient({ memberKeySuiteId: KEY_WRAPPER_SUITE.active, memberKeyVersion: 5, privateKey: member.privateKey })

    await expect(openMemberVaultKey(parse(envelope), recipient)).rejects.toMatchObject({ code: 'recipient-mismatch' })
  })

  it('never reinterprets the session key under the suite named by the envelope', async () => {
    const recipient = await memberRecipient({ memberKeySuiteId: KEY_WRAPPER_SUITE.legacy, memberKeyVersion: 4, privateKey: member.privateKey })

    await expect(openMemberVaultKey(parse(envelope), recipient)).rejects.toMatchObject({ code: 'recipient-mismatch' })
  })

  type Descriptor = Awaited<ReturnType<typeof wireEnvelope>>['wrappedVaultKey']['descriptor']
  it.each<[string, (descriptor: Descriptor) => Partial<Descriptor>, string]>([
    ['an unregistered suite', () => ({ wrapperSuiteId: 'palladin-unknown-v9' }), 'unsupported-suite'],
    ['a substituted recipient fingerprint', () => ({ recipientFingerprint: toBase64Url(new Uint8Array(32)) }), 'recipient-mismatch'],
    ['a substituted Vault scope', (descriptor) => ({ scope: { ...descriptor.scope, vaultId: '44444444-4444-4444-8444-444444444444' } }), 'open-failed'],
  ])('fails closed for %s', async (_name, change, code) => {
    const descriptor = envelope.wrappedVaultKey.descriptor
    const wire = { wrappedVaultKey: { ...envelope.wrappedVaultKey, descriptor: { ...descriptor, ...change(descriptor) } } }
    const recipient = await memberRecipient({ memberKeySuiteId: KEY_WRAPPER_SUITE.active, memberKeyVersion: 4, privateKey: member.privateKey })

    await expect(openMemberVaultKey(parse(wire), recipient)).rejects.toMatchObject({ code })
  })

  it.each([
    ['an algorithm-named key kind', { recipientKeyKind: 'memberX25519' }],
    ['a non-member purpose', { purpose: 'grantDek' }],
  ])('rejects %s at the wire boundary', (_name, change) => {
    const wire = { wrappedVaultKey: { ...envelope.wrappedVaultKey, descriptor: { ...envelope.wrappedVaultKey.descriptor, ...change } } }

    expect(memberVaultKeyEnvelopeSchema.safeParse(wire).success).toBe(false)
  })
})
