/**
 * How a locked session obtains its keys — an Open/Closed seam for E2.
 *
 * Today the only way to unlock is the master password: re-derive the master key
 * with Argon2id and unwrap the private key. E2 adds a `RuntimeUnlock` that gets
 * keys from a separately authorized Rust runtime after a biometric prompt (Touch ID / Windows
 * Hello, plan §5) — a different source, the same contract. The manager depends
 * only on {@link UnlockSource}, so a new source is added without touching the
 * session lifecycle.
 *
 * SECURITY: a source only ever converts the cached NON-secret account material
 * (salt + wrapped private key) into in-memory keys. It never persists anything;
 * the caller owns the returned buffers and wipes them on lock.
 */

import {
  decryptWithKey,
  deriveIdentityV1,
  deriveIdentityV2,
  fromBase64Url,
  NotImplementedError,
  wipe,
} from "@palladin/crypto";

import {
  browserAccountSecretDevice,
  identityProfileVersion,
  loadDeviceAccountSecret,
  MAXIMUM_SECURITY_VERSION,
  memberKeySuiteForProfile,
  type AccountSecretDevice,
} from "./identity-profile";
import type { AccountMaterial, DerivedSessionKeys } from "./types";
import { SessionError } from "./types";

export interface UnlockSource {
  /** Stable identifier for diagnostics/audit (`'master-password'`, `'runtime'`). */
  readonly id: string;
  /**
   * Turn cached account material into fresh in-memory keys. Rejects with a
   * {@link SessionError} the caller can localise. Returned buffers are owned by
   * the caller.
   */
  deriveKeys(material: AccountMaterial, onManualProof?: (authCredential: Uint8Array) => void): Promise<DerivedSessionKeys>;
}

/**
 * The default source: the login password re-derives the master key through the
 * canonical Identity KDF and unwraps the private key. An Identity v2 account
 * also needs this browser's Secret Key. A failed MAC on the unwrap means the
 * wrong password — surfaced as `incorrect-password`.
 */
export class MasterPasswordUnlock implements UnlockSource {
  readonly id = "master-password";

  constructor(
    private readonly password: string,
    private readonly accountSecrets: AccountSecretDevice = browserAccountSecretDevice,
  ) {}

  async deriveKeys(material: AccountMaterial, onManualProof?: (authCredential: Uint8Array) => void): Promise<DerivedSessionKeys> {
    const version = identityProfileVersion(material.kdf);
    if (material.kdf.minimumSecurityVersion > MAXIMUM_SECURITY_VERSION) {
      throw new SessionError("unsupported-security", "A newer security version is required");
    }
    let accountSecret: Uint8Array | null = null;
    if (version === 2) {
      accountSecret = await loadDeviceAccountSecret(this.accountSecrets, material.accountId);
      if (!accountSecret) throw new SessionError("secret-key-required", "This browser has no Secret Key");
    }

    const salt = fromBase64Url(material.kdf.kdfSalt, 16);
    let identity: Awaited<ReturnType<typeof deriveIdentityV1>>;
    try {
      identity = accountSecret
        ? await deriveIdentityV2(this.password, accountSecret, material.accountId, salt)
        : await deriveIdentityV1(this.password, material.accountId, salt);
    } catch (error) {
      wipe(salt);
      throw error;
    } finally {
      if (accountSecret) wipe(accountSecret);
    }
    let encryptedPrivateKey: Uint8Array | null = null;
    try {
      let privateKey: Uint8Array;
      try {
        encryptedPrivateKey = fromBase64Url(material.encryptedPrivateKey, 4_096);
        privateKey = await decryptWithKey(encryptedPrivateKey, identity.masterKey);
      } catch {
        // Translate only private-key unwrap failures, never lifecycle cancellation.
        throw new SessionError("incorrect-password", "Master password is incorrect");
      }
      try {
        onManualProof?.(identity.authCredential);
      } catch (error) {
        wipe(privateKey);
        throw error;
      }
      return { masterKey: identity.masterKey, privateKey, memberKeySuiteId: memberKeySuiteForProfile(version) };
    } catch (error) {
      wipe(identity.masterKey);
      throw error;
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

  deriveKeys(_material: AccountMaterial): Promise<DerivedSessionKeys> {
    return Promise.reject(new NotImplementedError("RuntimeUnlock", "deriveKeys"));
  }
}
