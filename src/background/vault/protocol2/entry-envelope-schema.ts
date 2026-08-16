import { z } from 'zod'
import { envelopeDescriptorSchema, vaultEnvelopeSchema, x25519WrappedKeySchema } from './vault-key-material-schema'

const emptyBindingSchema = z.object({}).strict()
const vaultKeyBindingSchema = z.object({ wrappingVaultKeyVersion: z.number().int().min(0).max(0xffffffff) }).strict()
const memberSecretBindingSchema = z.object({
  operation: z.enum(['created', 'updated', 'archived', 'restored', 'deleted'])
    .transform((operation) => ({ created: 1, updated: 2, archived: 3, restored: 4, deleted: 5 } as const)[operation]),
}).strict()

function purposeBoundEnvelope<T extends z.ZodType>(binding: T, expectedPurpose: number) {
  return vaultEnvelopeSchema(binding).superRefine((envelope, context) => {
    if (envelope.descriptor.purpose !== expectedPurpose) {
      context.addIssue({ code: 'custom', message: 'Envelope purpose mismatch' })
    }
  })
}

export const memberIndexEnvelopeSchema = purposeBoundEnvelope(emptyBindingSchema, 5)
export const memberSecretEnvelopeSchema = purposeBoundEnvelope(memberSecretBindingSchema, 6)
export const agentDiscoveryEnvelopeSchema = purposeBoundEnvelope(emptyBindingSchema, 7)
export const vaultEntryKeyEnvelopeSchema = purposeBoundEnvelope(vaultKeyBindingSchema, 8)

const reasonEnvelopeBindingSchema = z.object({
  wrapperSuiteId: z.literal('palladin-x25519-sealed-box-v1'),
  recipientKeyVersion: z.number().int().positive().max(0xffffffff),
  recipientKeyFingerprint: z.string().min(1),
  requestedMethods: z.number().int().min(1).max(0xffff),
}).strict()

export const encryptedReasonEnvelopeSchema = z.object({
  descriptor: envelopeDescriptorSchema(reasonEnvelopeBindingSchema),
  encodedSuitePayload: z.string().min(1),
  wrappedReasonDek: x25519WrappedKeySchema,
  agentSignature: z.string().min(1),
}).strict().superRefine((envelope, context) => {
  if (envelope.descriptor.purpose !== 9 || envelope.wrappedReasonDek.descriptor.purpose !== 3) {
    context.addIssue({ code: 'custom', message: 'Encrypted Reason purpose mismatch' })
  }
})

export const grantEnvelopeBindingSchema = z.object({
  entryRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  wrapperSuiteId: z.literal('palladin-x25519-sealed-box-v1'),
  recipientKeyVersion: z.number().int().min(0).max(0xffffffff),
  recipientKeyFingerprint: z.string().min(1),
  approvedMethods: z.number().int().min(0).max(0xffff),
  fieldSetCommitment: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  remainingUses: z.number().int().positive().nullable(),
}).strict()

export const grantEntryEnvelopeSchema = z.object({
  descriptor: envelopeDescriptorSchema(grantEnvelopeBindingSchema),
  encodedSuitePayload: z.string().min(1),
  wrappedGrantDek: x25519WrappedKeySchema,
  fieldIds: z.array(z.string().min(1)).min(1),
}).strict().superRefine((envelope, context) => {
  if (envelope.descriptor.purpose !== 10 || envelope.wrappedGrantDek.descriptor.purpose !== 4) {
    context.addIssue({ code: 'custom', message: 'Grant envelope purpose mismatch' })
  }
})

export type MemberIndexEnvelopeContract = z.infer<typeof memberIndexEnvelopeSchema>
export type MemberSecretEnvelopeContract = z.infer<typeof memberSecretEnvelopeSchema>
export type VaultEntryKeyEnvelopeContract = z.infer<typeof vaultEntryKeyEnvelopeSchema>

