/**
 * How a locked session obtains its keys — an Open/Closed seam for E2.
 *
 * Today the only way to unlock is the master password: re-derive the master key
 * with Argon2id and unwrap the private key. E2 adds a `RuntimeUnlock` that gets
 * keys from the paired Rust runtime after a biometric prompt (Touch ID / Windows
 * Hello, plan §5) — a different source, the same contract. The manager depends
 * only on {@link UnlockSource}, so a new source is added without touching the
 * session lifecycle.
 *
 * SECURITY: a source only ever converts the cached NON-secret account material
 * (salt + wrapped private key) into in-memory keys. It never persists anything;
 * the caller owns the returned buffers and wipes them on lock.
 */

import {
  assertIdentityKdfProfile,
  decryptWithKey,
  deriveIdentityV1,
  fromBase64Url,
  IDENTITY_KDF_PROFILE,
  NotImplementedError,
  wipe,
} from "@palladin/crypto";

import type { AccountMaterial, SessionKeys } from "./types";
import { SessionError } from "./types";

export interface UnlockSource {
  /** Stable identifier for diagnostics/audit (`'master-password'`, `'runtime'`). */
  readonly id: string;
  /**
   * Turn cached account material into fresh in-memory keys. Rejects with a
   * {@link SessionError} the caller can localise. Returned buffers are owned by
   * the caller.
   */
  deriveKeys(material: AccountMaterial): Promise<SessionKeys>;
}

/**
 * The default source: the login password re-derives the master key through the
 * canonical Identity KDF and unwraps the private key. A failed
 * MAC on the unwrap means the wrong password — surfaced as `incorrect-password`.
 */
export class MasterPasswordUnlock implements UnlockSource {
  readonly id = "master-password";

  constructor(private readonly password: string) {}

  async deriveKeys(material: AccountMaterial): Promise<SessionKeys> {
    try {
      assertIdentityKdfProfile({
        profileId: material.kdf.profileId,
        securityVersion: material.kdf.securityVersion,
        kdfSalt: material.kdf.kdfSalt,
        memoryKiB: IDENTITY_KDF_PROFILE.memoryKiB,
        iterations: IDENTITY_KDF_PROFILE.iterations,
        parallelism: IDENTITY_KDF_PROFILE.parallelism,
      });
    } catch {
      throw new SessionError("unsupported-security", "Unsupported Identity KDF profile");
    }
    if (material.kdf.minimumSecurityVersion > IDENTITY_KDF_PROFILE.securityVersion) {
      throw new SessionError("unsupported-security", "A newer security version is required");
    }

    const salt = fromBase64Url(material.kdf.kdfSalt, 16);
    const identity = await deriveIdentityV1(this.password, material.accountId, salt);
    let encryptedPrivateKey: Uint8Array | null = null;
    try {
      encryptedPrivateKey = fromBase64Url(material.encryptedPrivateKey, 4_096);
      const privateKey = await decryptWithKey(
        encryptedPrivateKey,
        identity.masterKey,
      );
      return { masterKey: identity.masterKey, privateKey };
    } catch {
      // Unwrap failed the MAC check: wrong password. Wipe the derived key so no
      // material lingers, and translate into a typed, value-free error.
      wipe(identity.masterKey);
      throw new SessionError("incorrect-password", "Master password is incorrect");
    } finally {
      wipe(salt);
      wipe(identity.authCredential);
      if (encryptedPrivateKey) wipe(encryptedPrivateKey);
    }
  }
}

/**
 * Reserved slot for E2 unlock via the native-messaging Rust runtime (biometric,
 * multi-profile). Typed and wired into the same contract now so the manager code
 * does not change when it lands; every operation throws until then.
 */
export class RuntimeUnlock implements UnlockSource {
  readonly id = "runtime";

  deriveKeys(_material: AccountMaterial): Promise<SessionKeys> {
    return Promise.reject(new NotImplementedError("RuntimeUnlock", "deriveKeys"));
  }
}
