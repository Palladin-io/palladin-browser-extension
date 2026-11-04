import {
  deriveRecipientPublicKey,
  openVaultProjection,
  RECIPIENT_KEY_KIND,
  type KeyWrapperRecipient,
} from "@palladin/crypto";

/** The signed-in member's own encryption key. Worker memory only. */
export interface MemberKey {
  /** Key-wrapper suite of the member key, fixed by the Identity security version. */
  readonly memberKeySuiteId: string;
  /** Member key directory version from authenticated account state. */
  readonly memberKeyVersion: number;
  readonly privateKey: Uint8Array;
}

type EncryptedVaultProjection = Parameters<typeof openVaultProjection>[0];
type OpenVaultProjectionResult = Awaited<ReturnType<typeof openVaultProjection>>;

/**
 * This member as a key-wrapper recipient, built only from the session's own
 * key and authenticated account state: suite and version come from Identity,
 * the public key and its fingerprint are computed from the private key. An
 * envelope addressed to any other key, suite or version fails closed.
 */
export async function memberRecipient(memberKey: MemberKey): Promise<KeyWrapperRecipient> {
  return {
    keySuiteId: memberKey.memberKeySuiteId,
    keyKind: RECIPIENT_KEY_KIND.memberEncryption,
    keyVersion: memberKey.memberKeyVersion,
    publicKey: await deriveRecipientPublicKey(memberKey.memberKeySuiteId, memberKey.privateKey),
    privateKey: memberKey.privateKey,
  };
}

/** Open the Member Vault key and metadata with this member's own key. */
export async function openMemberVaultProjection(
  vault: EncryptedVaultProjection,
  memberKey: MemberKey,
  memberId: string,
): Promise<OpenVaultProjectionResult> {
  return openVaultProjection(vault, await memberRecipient(memberKey), memberId);
}
