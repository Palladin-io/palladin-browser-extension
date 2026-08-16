import { NotImplementedError } from "@palladin/crypto";
import { describe, expect, it } from "vitest";

import { MasterPasswordUnlock, RuntimeUnlock } from "./unlock-source";
import { SessionError } from "./types";
import { accountMaterial, buildTestAccount } from "./test-support";

describe("MasterPasswordUnlock", () => {
  it("derives keys from the correct password", async () => {
    const account = await buildTestAccount();
    const keys = await new MasterPasswordUnlock(account.password)
      .deriveKeys(accountMaterial(account));
    expect(keys.masterKey).toHaveLength(32);
    expect(keys.privateKey).toHaveLength(32);
  });

  it("throws a typed incorrect-password error on a wrong password", async () => {
    const account = await buildTestAccount();
    await expect(
      new MasterPasswordUnlock("wrong").deriveKeys(accountMaterial(account)),
    ).rejects.toMatchObject({
      code: "incorrect-password",
      name: SessionError.name,
    });
  });
});

describe("RuntimeUnlock (E2 slot)", () => {
  it("is reserved and not implemented yet", async () => {
    await expect(
      new RuntimeUnlock().deriveKeys({
        accountId: "00112233-4455-4677-8899-aabbccddeeff",
        kdf: {
          securityVersion: 1,
          minimumSecurityVersion: 1,
          profileId: "identity-argon2id-password-v1",
          kdfSalt: "AAECAwQFBgcICQoLDA0ODw",
        },
        encryptedPrivateKey: "e",
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
