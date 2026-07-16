import { ENTRY_TYPE_CREDENTIAL, ENTRY_TYPE_KEY } from "@palladin/crypto";
import { describe, expect, it, vi } from "vitest";

import { FakeStorageArea } from "../session/test-support";
import { VaultClient } from "./vault-client";
import { VaultDataError, VaultDataService } from "./vault-data-service";
import { VaultStore } from "./vault-store";
import { buildVaultWorld, fakeSession, vaultBackend, type VaultWorld } from "./test-support";

const API = "http://api.test";

function makeService(world: VaultWorld, storage = new FakeStorageArea()) {
  const backend = vaultBackend(world, { validToken: "valid-token" });
  const client = new VaultClient(backend.fetch, API);
  const store = new VaultStore(storage);
  const session = fakeSession(world);
  return { service: new VaultDataService({ client, store, session }), storage, backend };
}

describe("VaultDataService.refresh", () => {
  it("caches entry metadata and wrapped keys without decrypting", async () => {
    const world = await buildVaultWorld();
    const { service } = makeService(world);

    const metadata = await service.refresh();

    expect(metadata.map((m) => ({ id: m.id, type: m.type, domain: m.urlDomain }))).toEqual([
      { id: "entry-cred", type: ENTRY_TYPE_CREDENTIAL, domain: "www.example.com" },
      { id: "entry-key", type: ENTRY_TYPE_KEY, domain: undefined },
    ]);
    // Cached copy matches.
    expect(await service.getMetadata()).toHaveLength(2);
  });

  it("clears the cache when signed out", async () => {
    const world = await buildVaultWorld();
    const storage = new FakeStorageArea();
    const { service } = makeService(world, storage);
    await service.refresh();

    const signedOut = new VaultDataService({
      client: new VaultClient(vaultBackend(world).fetch, API),
      store: new VaultStore(storage),
      session: fakeSession(world, { getAccessToken: () => Promise.resolve(null) }),
    });
    expect(await signedOut.refresh()).toEqual([]);
    expect(await signedOut.getMetadata()).toEqual([]);
  });

  it("refreshes the token once on a 401 and retries", async () => {
    const world = await buildVaultWorld();
    const refresh = vi.fn(() => Promise.resolve("valid-token"));
    const client = new VaultClient(vaultBackend(world, { validToken: "valid-token" }).fetch, API);
    const service = new VaultDataService({
      client,
      store: new VaultStore(new FakeStorageArea()),
      session: fakeSession(world, { token: "stale", refreshAccessToken: refresh }),
    });

    await service.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("throws not-authenticated when the refresh also fails", async () => {
    const world = await buildVaultWorld();
    const service = new VaultDataService({
      client: new VaultClient(vaultBackend(world, { validToken: "valid-token" }).fetch, API),
      store: new VaultStore(new FakeStorageArea()),
      session: fakeSession(world, {
        token: "stale",
        refreshAccessToken: () => Promise.resolve(null),
      }),
    });
    await expect(service.refresh()).rejects.toMatchObject({ code: "not-authenticated" });
  });
});

describe("VaultDataService.revealEntry", () => {
  it("decrypts a credential entry with the unsealed vault key", async () => {
    const world = await buildVaultWorld();
    const { service } = makeService(world);
    await service.refresh();

    const plaintext = await service.revealEntry("vault-1", "entry-cred");
    expect(plaintext.type).toBe(ENTRY_TYPE_CREDENTIAL);
    if (plaintext.type === ENTRY_TYPE_CREDENTIAL) {
      expect(plaintext.username).toBe("ada@example.com");
      expect(plaintext.password).toBe("s3cr3t-p@ss");
    }
  });

  it("throws locked when the session has no private key", async () => {
    const world = await buildVaultWorld();
    const storage = new FakeStorageArea();
    const { service } = makeService(world, storage);
    await service.refresh();

    const locked = new VaultDataService({
      client: new VaultClient(vaultBackend(world).fetch, API),
      store: new VaultStore(storage),
      session: fakeSession(world, { getPrivateKey: () => null }),
    });
    await expect(locked.revealEntry("vault-1", "entry-cred")).rejects.toBeInstanceOf(VaultDataError);
    await expect(locked.revealEntry("vault-1", "entry-cred")).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("never writes a plaintext secret to storage across sync + reveal", async () => {
    const world = await buildVaultWorld();
    const storage = new FakeStorageArea();
    const { service } = makeService(world, storage);
    await service.refresh();
    await service.revealEntry("vault-1", "entry-cred");
    await service.revealEntry("vault-1", "entry-key");

    // Everything the store persisted, serialised — must contain no plaintext.
    const dump = JSON.stringify(await storage.get(storage.keys()));
    expect(dump).not.toContain("s3cr3t-p@ss");
    expect(dump).not.toContain("ada@example.com");
    expect(dump).not.toContain("sk-key-value-xyz");
    // But it does hold the (ciphertext) wrapped key + non-secret metadata.
    expect(dump).toContain("Example login");
  });
});
