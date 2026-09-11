import {
  createSharedUnlockIdentityProofSigner, createSharedUnlockOffer, hashSharedUnlockTranscript, wipe,
  type SharedUnlockContext, type SharedUnlockIdentityProofContext, type SharedUnlockKeyContext,
  type SharedUnlockParticipant,
} from '@palladin/crypto'
import { recoverSharedUnlockKeys } from './shared-unlock-keys'
import type { SessionKeys } from '../../background/session/types'

/** Identity response material; only the consumed response supplies key authority. */
export interface SharedUnlockOperationMaterial {
  readonly context: SharedUnlockContext
  readonly sourcePublicKey: string
  readonly recipientPublicKey: string
  readonly recipientProofPublicKey: string
  readonly challenge: string
  readonly transcriptHash: string
  readonly keyContext: SharedUnlockKeyContext
}

export async function createSharedUnlockReceiverCrypto(assertCurrent: () => void) {
  const offer = await createSharedUnlockOffer({ role: 'recipient', assertCurrent })
  let signer: Awaited<ReturnType<typeof createSharedUnlockIdentityProofSigner>>
  try { assertCurrent(); signer = await createSharedUnlockIdentityProofSigner({ assertCurrent }) }
  catch (error) { offer.dispose(); throw error }
  try { assertCurrent() } catch (error) { offer.dispose(); signer.dispose(); throw error }
  let closed = false
  let proof: SharedUnlockIdentityProofContext | null = null
  let consumed: SharedUnlockOperationMaterial | null = null
  let participant: SharedUnlockParticipant | null = null
  let sourceKey: string | null = null
  let proofStarted = false
  const check = () => { if (closed) throw new Error('Shared unlock receiver disposed'); assertCurrent() }
  const binding = async (operation: SharedUnlockOperationMaterial, sourcePublicKey: string) => {
    check()
    if (operation.sourcePublicKey !== sourcePublicKey || operation.recipientPublicKey !== offer.publicKey
      || operation.recipientProofPublicKey !== signer.publicKey) throw new Error('Shared unlock participant binding failed')
    const digest = await hashSharedUnlockTranscript(operation.context, sourcePublicKey, offer.publicKey)
    check()
    if (digest !== operation.transcriptHash) throw new Error('Shared unlock transcript binding failed')
  }
  return {
    publicKey: offer.publicKey,
    proofPublicKey: signer.publicKey,
    async consumeProof(operation: SharedUnlockOperationMaterial, verifiedSourcePublicKey: string) {
      check()
      if (proofStarted) throw new Error('Shared unlock proof already started')
      proofStarted = true
      const captured = { ...operation, context: { ...operation.context } }
      sourceKey = verifiedSourcePublicKey
      await binding(captured, verifiedSourcePublicKey)
      proof = { operationId: captured.context.operationId, challenge: captured.challenge,
        transcriptHash: captured.transcriptHash, issuedAtMs: captured.context.issuedAtMs,
        expiresAtMs: captured.context.expiresAtMs }
      check()
      return signer.sign(proof, 'consume')
    },
    async acceptIdentity(operation: SharedUnlockOperationMaterial) {
      check()
      if (!proof || !sourceKey || consumed) throw new Error('Shared unlock consume order failed')
      const captured = { ...operation, context: { ...operation.context }, keyContext: { ...operation.keyContext } }
      await binding(captured, sourceKey)
      if (captured.context.operationId !== proof.operationId || captured.challenge !== proof.challenge
        || captured.transcriptHash !== proof.transcriptHash || captured.context.issuedAtMs !== proof.issuedAtMs
        || captured.context.expiresAtMs !== proof.expiresAtMs) throw new Error('Shared unlock Identity proof binding failed')
      check()
      participant = offer.bind(captured.context)
      consumed = captured
    },
    async open(envelope: unknown): Promise<SessionKeys> {
      check()
      if (!participant || !consumed || !sourceKey) throw new Error('Shared unlock consume required')
      let keys: SessionKeys | null = null
      let returned = false
      try {
        const mk = await participant.open(envelope, sourceKey)
        // recover owns MK immediately, including cancellation before its first await.
        keys = await recoverSharedUnlockKeys(mk, consumed.keyContext, consumed.context.accountId,
          consumed.context.keyContextDigest, check)
        check()
        returned = true
        return keys
      } finally { if (keys && !returned) { wipe(keys.masterKey); wipe(keys.privateKey) } }
    },
    commitProof() {
      check()
      if (!consumed || !proof) throw new Error('Shared unlock consume required')
      return signer.sign(proof, 'commit')
    },
    async verifyCommit(context: SharedUnlockContext) {
      check()
      if (!consumed || !sourceKey) throw new Error('Shared unlock consume required')
      const digest = await hashSharedUnlockTranscript({ ...context }, sourceKey, offer.publicKey)
      check()
      if (digest !== consumed.transcriptHash) throw new Error('Shared unlock commit binding failed')
    },
    dispose() { closed = true; offer.dispose(); participant?.dispose(); signer.dispose() },
  }
}
