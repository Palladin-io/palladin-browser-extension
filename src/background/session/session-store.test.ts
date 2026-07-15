import { describe, expect, it } from "vitest";

import { SessionStore } from "./session-store";
import { FakeStorageArea, toBase64 } from "./test-support";

describe("SessionStore", () => {
  it("round-trips tokens and account material", async () => {
    const store = new SessionStore(new FakeStorageArea());
    await store.setTokens({ accessToken: "a", refreshToken: "r", userId: "u" });
    await store.setMaterial({ salt: "s", encryptedPrivateKey: "e" });
    expect(await store.getTokens()).toEqual({ accessToken: "a", refreshToken: "r", userId: "u" });
    expect(await store.getMaterial()).toEqual({ salt: "s", encryptedPrivateKey: "e" });
  });

  it("persists keys as base64 and decodes them back to the same bytes", async () => {
    const store = new SessionStore(new FakeStorageArea());
    const masterKey = new Uint8Array([1, 2, 3, 4]);
    const privateKey = new Uint8Array([9, 8, 7, 6]);
    await store.setKeys({ masterKey, privateKey });

    const restored = await store.getKeys();
    expect(restored).not.toBeNull();
    expect(toBase64(restored!.masterKey)).toBe(toBase64(masterKey));
    expect(toBase64(restored!.privateKey)).toBe(toBase64(privateKey));
  });

  it("clearKeys drops only the keys, leaving tokens and material", async () => {
    const store = new SessionStore(new FakeStorageArea());
    await store.setTokens({ accessToken: "a", refreshToken: "r", userId: "u" });
    await store.setMaterial({ salt: "s", encryptedPrivateKey: "e" });
    await store.setKeys({ masterKey: new Uint8Array([1]), privateKey: new Uint8Array([2]) });

    await store.clearKeys();

    expect(await store.getKeys()).toBeNull();
    expect(await store.getTokens()).not.toBeNull();
    expect(await store.getMaterial()).not.toBeNull();
  });

  it("clearAll wipes every entry", async () => {
    const area = new FakeStorageArea();
    const store = new SessionStore(area);
    await store.setTokens({ accessToken: "a", refreshToken: "r", userId: "u" });
    await store.setKeys({ masterKey: new Uint8Array([1]), privateKey: new Uint8Array([2]) });
    await store.setAutoLock({ policy: "4h", lastActivityAt: 5 });

    await store.clearAll();

    expect(area.keys()).toHaveLength(0);
  });

  it("returns null for an absent key rather than undefined", async () => {
    const store = new SessionStore(new FakeStorageArea());
    expect(await store.getKeys()).toBeNull();
    expect(await store.getTokens()).toBeNull();
    expect(await store.getAutoLock()).toBeNull();
  });
});
