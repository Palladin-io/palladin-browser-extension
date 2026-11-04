import {
  deleteAccountSecretFromDevice,
  IDENTITY_ACCOUNT_SECRET_PROFILE,
  IDENTITY_KDF_PROFILE,
  identityKdfProfileVersion,
  loadAccountSecretFromDevice,
  storeAccountSecretOnDevice,
  wipe,
} from "@palladin/crypto";

import { SessionError } from "./types";

export type IdentityProfileVersion = 1 | 2;

const PROFILES = [IDENTITY_KDF_PROFILE, IDENTITY_ACCOUNT_SECRET_PROFILE] as const;
export const MAXIMUM_SECURITY_VERSION = IDENTITY_ACCOUNT_SECRET_PROFILE.securityVersion;

/**
 * Resolve a registered Identity KDF profile from its public metadata. Only the
 * password-only v1 and the Secret Key v2 profiles derive; anything else fails
 * before the KDF runs. Missing Argon2id parameters take the registered values,
 * because cached session material stores only the profile identity.
 */
export function identityProfileVersion(metadata: {
  readonly profileId: string;
  readonly securityVersion: number;
  readonly kdfSalt: string;
  readonly memoryKiB?: number;
  readonly iterations?: number;
  readonly parallelism?: number;
}): IdentityProfileVersion {
  const registered = PROFILES.find((profile) => profile.securityVersion === metadata.securityVersion);
  try {
    return identityKdfProfileVersion({
      profileId: metadata.profileId,
      securityVersion: metadata.securityVersion,
      kdfSalt: metadata.kdfSalt,
      memoryKiB: metadata.memoryKiB ?? registered?.memoryKiB ?? -1,
      iterations: metadata.iterations ?? registered?.iterations ?? -1,
      parallelism: metadata.parallelism ?? registered?.parallelism ?? -1,
    });
  } catch {
    throw new SessionError("unsupported-security", "Unsupported Identity KDF profile");
  }
}

export function isRegisteredProfile(securityVersion: number, profileId: string): boolean {
  return PROFILES.some((profile) => profile.securityVersion === securityVersion && profile.id === profileId);
}

/**
 * The Secret Key (Identity v2 Account Secret) on this browser. It is the one
 * explicit persistence exception: AES-GCM ciphertext under a non-extractable
 * WebCrypto key in the extension-origin IndexedDB. On its own it opens nothing.
 */
export interface AccountSecretDevice {
  load(accountId: string): Promise<Uint8Array | null>;
  store(accountId: string, accountSecret: Uint8Array): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export const browserAccountSecretDevice: AccountSecretDevice = {
  load: loadAccountSecretFromDevice,
  store: storeAccountSecretOnDevice,
  delete: deleteAccountSecretFromDevice,
};

/** An unreadable wrapper is treated as absent: the user re-provides the Secret Key. */
export async function loadDeviceAccountSecret(
  device: AccountSecretDevice,
  accountId: string,
): Promise<Uint8Array | null> {
  try {
    return await device.load(accountId);
  } catch {
    return null;
  }
}

export async function hasDeviceAccountSecret(device: AccountSecretDevice, accountId: string): Promise<boolean> {
  const secret = await loadDeviceAccountSecret(device, accountId);
  if (!secret) return false;
  wipe(secret);
  return true;
}
