import { z } from 'zod'
import {
  canonicalU64Schema as canonicalU64,
  canonicalUuidSchema as canonicalUuid,
  memberVaultKeyEnvelopeSchema,
  memberVaultMetadataEnvelopeSchema,
  u32Schema as u32,
  vaultDiscoveryKeyEnvelopeSchema,
  vaultPrivateKeyEnvelopeSchema,
} from './vault-key-material-schema'
import {
  agentDiscoveryEnvelopeSchema,
  memberIndexEnvelopeSchema,
  memberSecretEnvelopeSchema,
  vaultEntryKeyEnvelopeSchema,
} from './entry-envelope-schema'
export { memberIndexEnvelopeSchema, vaultEntryKeyEnvelopeSchema } from './entry-envelope-schema'

const syncCursor = z.string().max(2_048)

const vaultKeyEpochSchema = z.object({
  vaultKeyVersion: u32,
  vdkVersion: u32,
  agentMessageKeyVersion: u32,
  manifestSigningKeyVersion: u32,
}).strict()

const encryptedVaultSummaryShape = {
  id: canonicalUuid,
  isDefault: z.boolean(),
  protocolVersion: z.literal(2),
  memberSequence: canonicalU64,
  discoverySequence: canonicalU64,
  memberKeyGeneration: u32,
  currentKeyEpoch: vaultKeyEpochSchema,
  memberVaultMetadata: memberVaultMetadataEnvelopeSchema,
  memberVaultKey: memberVaultKeyEnvelopeSchema,
  discoveryKey: vaultDiscoveryKeyEnvelopeSchema,
  vaultPrivateKeys: z.array(vaultPrivateKeyEnvelopeSchema).length(2),
  createdAt: z.string(),
  updatedAt: z.string(),
  memberCount: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  activeGrantCount: z.number().int().nonnegative(),
} as const

const encryptedVaultListSummaryObjectSchema = z.object(encryptedVaultSummaryShape).strict()

function validateEncryptedVaultSummary(
  vault: z.infer<typeof encryptedVaultListSummaryObjectSchema>,
  context: z.RefinementCtx,
): void {
  const metadata = vault.memberVaultMetadata.descriptor
  const memberKey = vault.memberVaultKey.wrappedVaultKey.descriptor
  if (vault.id !== metadata.scope.vaultId || vault.id !== memberKey.scope.vaultId) {
    context.addIssue({ code: 'custom', message: 'Vault envelope scope mismatch' })
  }
  if (metadata.scope.organizationId !== memberKey.scope.organizationId) {
    context.addIssue({ code: 'custom', message: 'Vault organization scope mismatch' })
  }
  if (vault.memberKeyGeneration !== memberKey.memberKeyGeneration) {
    context.addIssue({ code: 'custom', message: 'Vault member generation mismatch' })
  }
  if (vault.currentKeyEpoch.vaultKeyVersion !== memberKey.wrappedKeyVersion) {
    context.addIssue({ code: 'custom', message: 'Vault key version mismatch' })
  }
}

export const encryptedVaultListSummarySchema = encryptedVaultListSummaryObjectSchema
  .superRefine(validateEncryptedVaultSummary)

const vaultPublicKeySchema = z.object({
  protocolVersion: z.literal(2),
  schemeId: z.enum(['palladin-x25519-v1', 'palladin-ed25519-v1']),
  keyKind: z.enum(['agentMessageX25519', 'manifestSigningEd25519']),
  keyVersion: u32,
  encodedPublicKey: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict()

export const encryptedVaultSummarySchema = z.object({
  ...encryptedVaultSummaryShape,
  organizationId: canonicalUuid,
  metadataRevision: canonicalU64,
  vaultAgentMessagePublicKey: vaultPublicKeySchema,
  vaultManifestSigningPublicKey: vaultPublicKeySchema,
}).strict().superRefine((vault, context) => {
  validateEncryptedVaultSummary(vault, context)
  const metadataOrganizationId = vault.memberVaultMetadata.descriptor.scope.organizationId
  const memberKeyOrganizationId = vault.memberVaultKey.wrappedVaultKey.descriptor.scope.organizationId
  if (vault.organizationId !== metadataOrganizationId
    || vault.organizationId !== memberKeyOrganizationId) {
    context.addIssue({ code: 'custom', message: 'Vault outer organization scope mismatch' })
  }
  if (vault.vaultAgentMessagePublicKey.keyKind !== 'agentMessageX25519'
    || vault.vaultAgentMessagePublicKey.schemeId !== 'palladin-x25519-v1'
    || vault.vaultAgentMessagePublicKey.keyVersion !== vault.currentKeyEpoch.agentMessageKeyVersion
    || vault.vaultManifestSigningPublicKey.keyKind !== 'manifestSigningEd25519'
    || vault.vaultManifestSigningPublicKey.schemeId !== 'palladin-ed25519-v1'
    || vault.vaultManifestSigningPublicKey.keyVersion !== vault.currentKeyEpoch.manifestSigningKeyVersion) {
    context.addIssue({ code: 'custom', message: 'Vault public key epoch mismatch' })
  }
})

const entryStateSchema = z.union([
  z.enum(['active', 'archived', 'deleted']),
  z.literal(1), z.literal(2), z.literal(3),
]).transform((state) => typeof state === 'number'
  ? ({ 1: 'active', 2: 'archived', 3: 'deleted' } as const)[state]
  : state)

const headSchema = z.object({
  entryId: canonicalUuid,
  kind: z.literal('head'),
  state: entryStateSchema,
  updatedAt: z.string().datetime({ offset: true }),
  currentRevision: canonicalU64,
  memberIndexRevision: canonicalU64,
  currentKeyVersion: u32,
  entryKey: vaultEntryKeyEnvelopeSchema,
  memberIndex: memberIndexEnvelopeSchema,
}).strict().superRefine((item, context) => {
  const index = item.memberIndex.descriptor
  const entryKey = item.entryKey.descriptor
  if (item.entryId !== index.scope.entryId
    || item.entryId !== entryKey.scope.entryId
    || item.memberIndexRevision !== index.resourceRevision
    || item.currentKeyVersion !== entryKey.keyVersion
    || index.keyVersion !== item.currentKeyVersion
    || index.memberKeyGeneration !== entryKey.memberKeyGeneration) {
    context.addIssue({ code: 'custom', message: 'Member sync head binding mismatch' })
  }
})

const tombstoneSchema = z.object({
  entryId: canonicalUuid,
  kind: z.literal('tombstone'),
  state: z.null(),
  updatedAt: z.null(),
  currentRevision: z.null(),
  memberIndexRevision: z.null(),
  currentKeyVersion: z.null(),
  entryKey: z.null(),
  memberIndex: z.null(),
}).strict()

export const memberSyncItemSchema = z.discriminatedUnion('kind', [headSchema, tombstoneSchema])

export const listVaultsSchema = z.object({
  vaults: z.array(encryptedVaultListSummarySchema).max(200),
  total: z.number().int().nonnegative(),
}).strict()

export const snapshotSchema = z.object({
  snapshotBaseSequence: canonicalU64,
  items: z.array(memberSyncItemSchema).max(200),
  nextCursor: syncCursor.nullable(),
}).strict()

export const deltaSchema = z.object({
  deltaUpperBound: canonicalU64,
  appliedThroughSequence: canonicalU64,
  items: z.array(memberSyncItemSchema).max(200),
  continuationCursor: syncCursor.nullable(),
}).strict()

export const resetSchema = z.object({
  outcome: z.literal('resetRequired'),
  currentSequence: canonicalU64,
  minRetainedSequence: canonicalU64,
  newSnapshotRequired: z.literal(true),
}).strict()

export type EncryptedVaultSummary = z.infer<typeof encryptedVaultSummarySchema>
export type EncryptedVaultListSummary = z.infer<typeof encryptedVaultListSummarySchema>
export type MemberSyncItem = z.infer<typeof memberSyncItemSchema>
export type MemberSnapshotPage = z.infer<typeof snapshotSchema>
export type MemberDeltaPage = z.infer<typeof deltaSchema>

export const canonicalEntryDetailSchema = z.object({
  organizationId: canonicalUuid,
  vaultId: canonicalUuid,
  id: canonicalUuid,
  state: z.union([z.enum(['active', 'archived', 'deleted']), z.literal(1), z.literal(2), z.literal(3)]),
  currentRevision: canonicalU64,
  memberIndexRevision: canonicalU64,
  agentDiscoveryRevision: canonicalU64.nullable(),
  agentDiscoveryRevisionHighWatermark: canonicalU64,
  currentKeyVersion: u32,
  createdAt: z.string(),
  createdBy: canonicalUuid,
  updatedAt: z.string(),
  updatedBy: canonicalUuid,
  memberIndex: memberIndexEnvelopeSchema,
  memberSecret: memberSecretEnvelopeSchema,
  agentDiscovery: agentDiscoveryEnvelopeSchema.nullable(),
  entryKey: vaultEntryKeyEnvelopeSchema,
}).strict().superRefine((entry, context) => {
  const envelopes = [entry.memberIndex, entry.memberSecret, entry.entryKey, entry.agentDiscovery].filter(Boolean)
  if (envelopes.some((envelope) => envelope!.descriptor.scope.organizationId !== entry.organizationId
    || envelope!.descriptor.scope.vaultId !== entry.vaultId || envelope!.descriptor.scope.entryId !== entry.id)) {
    context.addIssue({ code: 'custom', message: 'Entry envelope scope mismatch' })
  }
  if (entry.currentRevision !== entry.memberSecret.descriptor.resourceRevision
    || entry.memberIndexRevision !== entry.memberIndex.descriptor.resourceRevision
    || entry.currentKeyVersion !== entry.entryKey.descriptor.keyVersion
    || entry.agentDiscoveryRevision !== (entry.agentDiscovery?.descriptor.resourceRevision ?? null)) {
    context.addIssue({ code: 'custom', message: 'Entry projection head mismatch' })
  }
  if (entry.agentDiscoveryRevision !== null
    && BigInt(entry.agentDiscoveryRevision) > BigInt(entry.agentDiscoveryRevisionHighWatermark)) {
    context.addIssue({ code: 'custom', message: 'Entry Discovery watermark mismatch' })
  }
})
