import type { SharedUnlockOperation } from './api-types'

/** Outgoing browser protocol projection, not REST response validation.
 * Future Identity response fields must never be forwarded to a peer implicitly. */
export function sharedUnlockOperationMessage(operation: SharedUnlockOperation): SharedUnlockOperation {
  const c = operation.context
  const k = operation.keyContext
  return {
    context: {
      protocol: c.protocol, direction: c.direction, operationId: c.operationId,
      accountId: c.accountId, organizationId: c.organizationId, apiOrigin: c.apiOrigin,
      webOrigin: c.webOrigin, extensionId: c.extensionId, documentBinding: c.documentBinding,
      webGeneration: c.webGeneration, extensionGeneration: c.extensionGeneration,
      linkId: c.linkId, linkEpoch: c.linkEpoch, preferenceRevision: c.preferenceRevision,
      authorizationVersion: c.authorizationVersion, keyContextDigest: c.keyContextDigest,
      issuedAtMs: c.issuedAtMs, expiresAtMs: c.expiresAtMs, unlockedAtMs: c.unlockedAtMs,
      idleDeadlineMs: c.idleDeadlineMs, absoluteDeadlineMs: c.absoluteDeadlineMs, offlineDeadlineMs: c.offlineDeadlineMs,
    },
    sourcePublicKey: operation.sourcePublicKey, recipientPublicKey: operation.recipientPublicKey,
    recipientProofPublicKey: operation.recipientProofPublicKey, challenge: operation.challenge,
    transcriptHash: operation.transcriptHash,
    keyContext: {
      accountId: k.accountId, securityVersion: k.securityVersion, minimumSecurityVersion: k.minimumSecurityVersion,
      kdfProfileId: k.kdfProfileId, kdfSalt: k.kdfSalt, credentialRevision: k.credentialRevision,
      privateKeyWrapRevision: k.privateKeyWrapRevision, memberKeyVersion: k.memberKeyVersion,
      publicKey: k.publicKey, encryptedPrivateKey: k.encryptedPrivateKey,
    },
  }
}
