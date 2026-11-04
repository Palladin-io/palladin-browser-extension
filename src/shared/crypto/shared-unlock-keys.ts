import {
  decryptWithKey, deriveRecipientPublicKey, fromBase64Url, hashSharedUnlockKeyContext, toBase64Url, wipe,
  type SharedUnlockKeyContext,
} from "@palladin/crypto";
import {
  identityProfileVersion, memberKeySuiteForProfile,
} from "../../background/session/identity-profile";
import type { SessionKeys } from "../../background/session/types";

/**
 * Identity's descriptor and the operation commitment are independent of the peer
 * envelope. Owns the supplied temporary MK on entry, including every failure.
 * Browser/lifecycle authority stays with the caller's synchronous fence.
 */
export async function recoverSharedUnlockKeys(
  masterKey: Uint8Array,
  descriptor: SharedUnlockKeyContext,
  expectedAccountId: string,
  expectedDigest: string,
  assertCurrent: () => void,
): Promise<SessionKeys> {
  const context = { ...descriptor };
  let privateKey: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;
  let publicKey: Uint8Array | null = null;
  let recovered = false;
  try {
    assertCurrent();
    if (context.accountId !== expectedAccountId || masterKey.length !== 32) throw new Error("Shared unlock key binding failed");
    // identity-kdf v3 accountKeys: the committed security version fixes the member key suite.
    const memberKeySuiteId = memberKeySuiteForProfile(identityProfileVersion({
      profileId: context.kdfProfileId, securityVersion: context.securityVersion, kdfSalt: context.kdfSalt,
    }));
    if (context.minimumSecurityVersion > context.securityVersion
      || !Number.isInteger(context.memberKeyVersion) || context.memberKeyVersion < 1) {
      throw new Error("Unsupported shared unlock key context");
    }
    const digest = await hashSharedUnlockKeyContext(context);
    assertCurrent();
    if (digest !== expectedDigest) throw new Error("Shared unlock key commitment failed");
    ciphertext = fromBase64Url(context.encryptedPrivateKey, 4096);
    privateKey = await decryptWithKey(ciphertext, masterKey);
    assertCurrent();
    publicKey = await deriveRecipientPublicKey(memberKeySuiteId, privateKey);
    if (toBase64Url(publicKey) !== context.publicKey) throw new Error("Shared unlock member key binding failed");
    assertCurrent();
    recovered = true;
    return { masterKey, privateKey, memberKeySuiteId, memberKeyVersion: context.memberKeyVersion };
  } finally {
    if (ciphertext) wipe(ciphertext);
    if (publicKey) wipe(publicKey);
    if (!recovered) {
      wipe(masterKey);
      if (privateKey) wipe(privateKey);
    }
  }
}
