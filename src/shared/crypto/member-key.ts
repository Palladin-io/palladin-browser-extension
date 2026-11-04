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
  readonly privateKey: Uint8Array;
}

type EncryptedVaultProjection = Parameters<typeof openVaultProjection>[0];
type OpenVaultProjectionResult = Awaited<ReturnType<typeof openVaultProjection>>;

/**
 * This member as a key-wrapper recipient. The binding is the suite fingerprint
 * of the public key computed here from the private key, so an envelope
 * addressed to any other key or suite fails closed. The key version is a
 * directory label the sync access context authenticates; the fingerprint does
 * not depend on it.
 */
export async function memberRecipient(memberKey: MemberKey, keyVersion: number): Promise<KeyWrapperRecipient> {
  return {
    keySuiteId: memberKey.memberKeySuiteId,
    keyKind: RECIPIENT_KEY_KIND.memberEncryption,
    keyVersion,
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
  const keyVersion = vault.memberVaultKey.wrappedVaultKey.descriptor.recipientKeyVersion;
  return openVaultProjection(vault, await memberRecipient(memberKey, keyVersion), memberId);
}
