import { describe, expect, it } from "vitest";

import { SessionStore } from "./session-store";
import { FakeStorageArea } from "./test-support";

describe("SessionStore", () => {
  it("round-trips tokens and account material", async () => {
    const store = new SessionStore(new FakeStorageArea());
    await store.setTokens({
      accessToken: "a",
      refreshToken: "r",
      userId: "u",
      apiUrl: "https://api.palladin.io",
    });
    await store.setMaterial({ salt: "s", encryptedPrivateKey: "e" });
    expect(await store.getTokens()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      userId: "u",
      apiUrl: "https://api.palladin.io",
    });
    expect(await store.getMaterial()).toEqual({ salt: "s", encryptedPrivateKey: "e" });
  });

  it("clearAll wipes every entry", async () => {
    const area = new FakeStorageArea();
    const store = new SessionStore(area);
    await store.setTokens({
      accessToken: "a",
      refreshToken: "r",
      userId: "u",
      apiUrl: "https://api.palladin.io",
    });
    await store.setAutoLock({ policy: "4h", lastActivityAt: 5 });

    await store.clearAll();

    expect(area.keys()).toHaveLength(0);
  });

  it("returns null for an absent key rather than undefined", async () => {
    const store = new SessionStore(new FakeStorageArea());
    expect(await store.getTokens()).toBeNull();
    expect(await store.getAutoLock()).toBeNull();
  });
});
