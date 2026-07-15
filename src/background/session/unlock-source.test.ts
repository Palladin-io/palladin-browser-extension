import { NotImplementedError } from "@palladin/crypto";
import { describe, expect, it } from "vitest";

import { MasterPasswordUnlock, RuntimeUnlock } from "./unlock-source";
import { SessionError } from "./types";
import { buildTestAccount } from "./test-support";

describe("MasterPasswordUnlock", () => {
  it("derives keys from the correct password", async () => {
    const account = await buildTestAccount();
    const keys = await new MasterPasswordUnlock(account.password).deriveKeys({
      salt: account.salt,
      encryptedPrivateKey: account.encryptedPrivateKey,
    });
    expect(keys.masterKey).toHaveLength(32);
    expect(keys.privateKey).toHaveLength(32);
  });

  it("throws a typed incorrect-password error on a wrong password", async () => {
    const account = await buildTestAccount();
    await expect(
      new MasterPasswordUnlock("wrong").deriveKeys({
        salt: account.salt,
        encryptedPrivateKey: account.encryptedPrivateKey,
      }),
    ).rejects.toMatchObject({
      code: "incorrect-password",
      name: SessionError.name,
    });
  });
});

describe("RuntimeUnlock (E2 slot)", () => {
  it("is reserved and not implemented yet", async () => {
    await expect(
      new RuntimeUnlock().deriveKeys({ salt: "s", encryptedPrivateKey: "e" }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
