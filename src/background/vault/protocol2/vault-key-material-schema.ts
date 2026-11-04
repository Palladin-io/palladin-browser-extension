import { fromWireKeyWrapperDescriptor, type WireKeyWrapperDescriptor } from '@palladin/crypto'
import { z } from 'zod'

export const canonicalUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
export const canonicalU64Schema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 0xffffffffffffffffn)
export const u32Schema = z.number().int().min(0).max(0xffffffff)

const optionalScopeIdSchema = canonicalUuidSchema.nullable()

export const envelopeScopeSchema = z.object({
  organizationId: canonicalUuidSchema,
  vaultId: canonicalUuidSchema,
  entryId: optionalScopeIdSchema,
  grantOrRequestId: optionalScopeIdSchema,
  agentId: optionalScopeIdSchema,
  memberId: optionalScopeIdSchema,
}).strict()

const envelopePurposeValues = {
  memberVaultMetadata: 1,
  vaultDiscoveryKey: 2,
  vaultAgentMessagePrivateKey: 3,
  vaultManifestSigningPrivateKey: 4,
  memberIndex: 5,
  memberSecret: 6,
  agentDiscovery: 7,
  entryDekByVaultKey: 8,
  encryptedReason: 9,
  grantPayload: 10,
} as const

const envelopePurposeSchema = z.enum(Object.keys(envelopePurposeValues) as [keyof typeof envelopePurposeValues, ...(keyof typeof envelopePurposeValues)[]])
  .transform((purpose) => envelopePurposeValues[purpose])

export function envelopeDescriptorSchema<T extends z.ZodType>(binding: T) {
  return z.object({
    protocolVersion: z.literal(2),
    cryptoSuiteId: z.literal('palladin-vault-xchacha-v1'),
    purpose: envelopePurposeSchema,
    scope: envelopeScopeSchema,
    resourceRevision: canonicalU64Schema,
    keyVersion: u32Schema,
    memberKeyGeneration: u32Schema.nullable(),
    binding,
  }).strict()
}

export function vaultEnvelopeSchema<T extends z.ZodType>(binding: T) {
  return z.object({
    descriptor: envelopeDescriptorSchema(binding),
    encodedSuitePayload: z.string().min(1),
  }).strict()
}

const vaultKeyBindingSchema = z.object({ wrappingVaultKeyVersion: u32Schema }).strict()
const emptyBindingSchema = z.object({}).strict()

// The algorithm travels only in wrapperSuiteId; registry names map to the
// numeric descriptor through @palladin/crypto, which fails closed on unknown names.
const wrapperDescriptorSchema = z.object({
  protocolVersion: z.literal(2),
  wrapperSuiteId: z.string().min(1),
  purpose: z.string().min(1),
  scope: envelopeScopeSchema,
  resourceRevision: canonicalU64Schema,
  wrappedKeyVersion: u32Schema,
  memberKeyGeneration: u32Schema.nullable(),
  recipientKeyKind: z.string().min(1),
  recipientKeyVersion: u32Schema,
  recipientFingerprint: z.string().min(1),
  parentDescriptorHash: z.string().min(1).nullable(),
}).strict().transform((wire, context) => {
  try {
    const { purpose, recipientKeyKind } = fromWireKeyWrapperDescriptor(wire as WireKeyWrapperDescriptor)
    return { ...wire, purpose, recipientKeyKind }
  } catch {
    context.addIssue({ code: 'custom', message: 'Unregistered key-wrapper purpose or recipient key kind' })
    return z.NEVER
  }
})

export const wrappedKeySchema = z.object({
  descriptor: wrapperDescriptorSchema,
  encodedSealedKeyPackage: z.string().min(1),
}).strict()

export const memberVaultMetadataEnvelopeSchema = vaultEnvelopeSchema(emptyBindingSchema)
  .refine((envelope) => envelope.descriptor.purpose === 1, 'Member Vault Metadata purpose mismatch')
export const vaultDiscoveryKeyEnvelopeSchema = vaultEnvelopeSchema(vaultKeyBindingSchema)
  .refine((envelope) => envelope.descriptor.purpose === 2, 'Vault Discovery Key purpose mismatch')
export const vaultPrivateKeyEnvelopeSchema = vaultEnvelopeSchema(vaultKeyBindingSchema)
  .refine((envelope) => envelope.descriptor.purpose === 3 || envelope.descriptor.purpose === 4,
    'Vault private key purpose mismatch')
export const memberVaultKeyEnvelopeSchema = z.object({ wrappedVaultKey: wrappedKeySchema }).strict()
  .refine((envelope) => envelope.wrappedVaultKey.descriptor.purpose === 1,
    'Member Vault Key wrapper purpose mismatch')

export type VaultDiscoveryKeyEnvelope = z.infer<typeof vaultDiscoveryKeyEnvelopeSchema>
export type VaultPrivateKeyEnvelope = z.infer<typeof vaultPrivateKeyEnvelopeSchema>

