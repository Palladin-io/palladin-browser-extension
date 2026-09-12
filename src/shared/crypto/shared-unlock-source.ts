import { createSharedUnlockOffer, hashSharedUnlockTranscript, loadSodium, wipe } from '@palladin/crypto'
import type { SharedUnlockOperationMaterial } from './shared-unlock-receiver'
import { recoverSharedUnlockKeys } from './shared-unlock-keys'

/** Own verified MK/private key are borrowed only for this call; temporary copies are owned here. */
export async function createSharedUnlockSourceCrypto(assertCurrent: () => void) {
  const offer = await createSharedUnlockOffer({ role: 'source', assertCurrent })
  let closed = false
  let sealed = false
  const check = () => { if (closed) throw new Error('Shared unlock source disposed'); assertCurrent() }
  try { check() } catch (error) { offer.dispose(); throw error }
  return {
    publicKey: offer.publicKey,
    async seal(operation: SharedUnlockOperationMaterial, verifiedRecipient: { publicKey: string; proofPublicKey: string },
      masterKey: Uint8Array, ownPrivateKey: Uint8Array) {
      check()
      if (sealed) throw new Error('Shared unlock source already used')
      sealed = true
      const current = { ...operation, context: { ...operation.context }, keyContext: { ...operation.keyContext } }
      if (current.sourcePublicKey !== offer.publicKey || current.recipientPublicKey !== verifiedRecipient.publicKey
        || current.recipientProofPublicKey !== verifiedRecipient.proofPublicKey) throw new Error('Shared unlock participant binding failed')
      const transcript = await hashSharedUnlockTranscript(current.context, offer.publicKey, verifiedRecipient.publicKey)
      check()
      if (transcript !== current.transcriptHash) throw new Error('Shared unlock transcript binding failed')
      const keys = await recoverSharedUnlockKeys(new Uint8Array(masterKey), current.keyContext,
        current.context.accountId, current.context.keyContextDigest, check)
      try {
        check()
        const sodium = await loadSodium()
        check()
        if (!sodium.memcmp(keys.privateKey, ownPrivateKey)) throw new Error('Shared unlock own member key differs')
        const participant = offer.bind(current.context)
        try { const envelope = await participant.seal(keys.masterKey, verifiedRecipient.publicKey); check(); return envelope }
        finally { participant.dispose() }
      } finally { wipe(keys.masterKey); wipe(keys.privateKey) }
    },
    dispose() { closed = true; offer.dispose() },
  }
}
