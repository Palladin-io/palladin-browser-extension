import { beforeAll, describe, expect, it } from "vitest";
import {
  encryptWithKey, generateKeyPair, hashSharedUnlockKeyContext, IDENTITY_KDF_PROFILE_ID,
  randomBytes, toBase64Url, type SharedUnlockKeyContext,
} from "@palladin/crypto";
import { recoverSharedUnlockKeys } from "./shared-unlock-keys";

const accountId = "11111111-1111-4111-8111-111111111111";
let masterKey: Uint8Array;
let privateKey: Uint8Array;
let descriptor: SharedUnlockKeyContext;
let digest: string;
beforeAll(async () => {
  masterKey = await randomBytes(32);
  const pair = await generateKeyPair(); privateKey = pair.privateKey;
  descriptor = {
    accountId, securityVersion: 1, minimumSecurityVersion: 1, kdfProfileId: IDENTITY_KDF_PROFILE_ID,
    kdfSalt: toBase64Url(await randomBytes(16)), credentialRevision: 2, privateKeyWrapRevision: 3,
    memberKeyVersion: 4, publicKey: toBase64Url(pair.publicKey),
    encryptedPrivateKey: toBase64Url(await encryptWithKey(privateKey, masterKey)),
  };
  digest = await hashSharedUnlockKeyContext(descriptor);
});

describe("shared unlock key recovery", () => {
  it("opens the wrapper and verifies the independently committed public key", async () => {
    const candidate = masterKey.slice();
    const keys = await recoverSharedUnlockKeys(candidate, descriptor, accountId, digest, () => {});
    expect(keys.masterKey).toBe(candidate);
    expect(keys.privateKey).toEqual(privateKey);
  });

  for (const variant of ["account", "digest", "wrapper", "public-key", "minimum-version", "profile"] as const) {
    it(`rejects ${variant} substitution and erases the supplied temporary MK`, async () => {
      const candidate = masterKey.slice();
      const context = { ...descriptor };
      let expectedDigest = digest;
      let expectedAccountId = accountId;
      if (variant === "account") expectedAccountId = "22222222-2222-4222-8222-222222222222";
      if (variant === "digest") expectedDigest = toBase64Url(new Uint8Array(32));
      if (variant === "wrapper") context.encryptedPrivateKey = toBase64Url(new Uint8Array(72));
      if (variant === "public-key") {
        context.publicKey = toBase64Url((await generateKeyPair()).publicKey);
        expectedDigest = await hashSharedUnlockKeyContext(context);
      }
      if (variant === "minimum-version") context.minimumSecurityVersion = 2;
      if (variant === "profile") context.kdfProfileId = "unknown";
      await expect(recoverSharedUnlockKeys(candidate, context, expectedAccountId, expectedDigest, () => {})).rejects.toThrow();
      expect(candidate).toEqual(new Uint8Array(32));
    });
  }

  for (const checkpoint of [1, 2, 3, 4, 5]) {
    it(`erases material when the lifecycle changes at checkpoint ${checkpoint}`, async () => {
      const candidate = masterKey.slice(); let count = 0;
      await expect(recoverSharedUnlockKeys(candidate, descriptor, accountId, digest, () => {
        if (++count === checkpoint) throw new Error("cancelled");
      })).rejects.toThrow("cancelled");
      expect(candidate).toEqual(new Uint8Array(32));
    });
  }
});
