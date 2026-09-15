import * as crypto from "@palladin/crypto";
import { NotImplementedError } from "@palladin/crypto";
import { describe, expect, it, vi } from "vitest";

import { MasterPasswordUnlock, RuntimeUnlock } from "./unlock-source";
import { SessionError } from "./types";
import { accountMaterial, buildTestAccount } from "./test-support";

vi.mock("@palladin/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@palladin/crypto")>();
  return {
    ...actual,
    deriveIdentityV1: vi.fn(actual.deriveIdentityV1),
    decryptWithKey: vi.fn(actual.decryptWithKey),
  };
});

describe("MasterPasswordUnlock", () => {
  it("derives keys from the correct password", async () => {
    const account = await buildTestAccount();
    const keys = await new MasterPasswordUnlock(account.password)
      .deriveKeys(accountMaterial(account));
    expect(keys.masterKey).toHaveLength(32);
    expect(keys.privateKey).toHaveLength(32);
  }, 15_000);

  it("preserves cancellation after unwrap and wipes all derived material", async () => {
    const account = await buildTestAccount();
    const derive = vi.mocked(crypto.deriveIdentityV1).mockClear();
    const decrypt = vi.mocked(crypto.decryptWithKey).mockClear();
    const cancelled = new SessionError("not-authenticated", "Session changed");
    try {
      await expect(new MasterPasswordUnlock(account.password).deriveKeys(
        accountMaterial(account),
        () => { throw cancelled; },
      )).rejects.toBe(cancelled);

      const identity = await derive.mock.results[0]!.value;
      const privateKey = await decrypt.mock.results[0]!.value;
      for (const buffer of [identity.masterKey, identity.authCredential, privateKey,
        derive.mock.calls[0]![2], decrypt.mock.calls[0]![0]]) {
        expect(buffer).toEqual(new Uint8Array(buffer.length));
      }
    } finally {
      derive.mockClear();
      decrypt.mockClear();
    }
  }, 15_000);

  it("throws a typed incorrect-password error on a wrong password", async () => {
    const account = await buildTestAccount();
    await expect(
      new MasterPasswordUnlock("wrong").deriveKeys(accountMaterial(account)),
    ).rejects.toMatchObject({
      code: "incorrect-password",
      name: SessionError.name,
    });
  }, 15_000);
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
