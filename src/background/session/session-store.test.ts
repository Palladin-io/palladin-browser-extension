import {
  sealBrowserSessionEnvelope,
  type BrowserSessionEnvelopeContext,
} from "@palladin/crypto";
import { describe, expect, it } from "vitest";

import { SessionStore } from "./session-store";
import { FakeStorageArea } from "./test-support";

const SEALED_KEY = "palladin.session.sealed.v1";

const context: BrowserSessionEnvelopeContext = {
  apiUrl: "https://api.palladin.io",
  accountId: "00112233-4455-4677-8899-aabbccddeeff",
  clientId: "palladin-browser-extension-test-client",
  identitySecurityVersion: 1,
  minimumIdentitySecurityVersion: 1,
  kdfProfileId: "identity-argon2id-password-v1",
  kdfSalt: "AAECAwQFBgcICQoLDA0ODw",
  encryptedPrivateKey: "AQIDBA",
  issuedAt: 1_000,
  expiresAt: 2_000,
};

async function envelope() {
  return sealBrowserSessionEnvelope(
    new TextEncoder().encode('{"state":"refresh-pending"}'),
    new Uint8Array(32).fill(0x41),
    context,
  );
}

describe("SessionStore", () => {
  it("round-trips only a validated sealed session envelope", async () => {
    const area = new FakeStorageArea();
    const store = new SessionStore(area);
    const sealed = await envelope();

    await store.setSealedSession(sealed);

    expect(await store.getSealedSession()).toEqual(sealed);
    expect(area.keys()).toEqual([SEALED_KEY]);
    expect(JSON.stringify(await store.getSealedSession())).not.toContain("refreshToken");
  });

  it("deletes malformed durable state instead of trusting or migrating it", async () => {
    const area = new FakeStorageArea();
    await area.set({ [SEALED_KEY]: { protocolVersion: 0, refreshToken: "plaintext" } });
    const store = new SessionStore(area);

    expect(await store.getSealedSession()).toBeNull();
    expect(area.keys()).toEqual([]);
  });

  it("clearAll wipes durable and legacy session entries", async () => {
    const durable = new FakeStorageArea();
    const legacy = new FakeStorageArea();
    const store = new SessionStore(durable, legacy);
    await store.setSealedSession(await envelope());
    await store.setAutoLock({ policy: "4h", lastActivityAt: 5 });
    await legacy.set({
      "palladin.session.tokens": { accessToken: "a", refreshToken: "r" },
      "palladin.session.material": { encryptedPrivateKey: "e" },
      "palladin.session.keys": { masterKey: "forbidden" },
    });

    await store.clearAll();

    expect(durable.keys()).toHaveLength(0);
    expect(legacy.keys()).toHaveLength(0);
  });

  it("returns null for absent state", async () => {
    const store = new SessionStore(new FakeStorageArea());
    expect(await store.getSealedSession()).toBeNull();
    expect(await store.getAutoLock()).toBeNull();
  });
});
