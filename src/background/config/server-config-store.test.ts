import { describe, expect, it, vi } from "vitest";

import {
  SERVER_CONFIG_KEY,
  ServerConfigStore,
  type LocalStorageArea,
} from "./server-config-store";

function storage(initial: Record<string, unknown> = {}): LocalStorageArea {
  const values = { ...initial };
  return {
    get: vi.fn(async () => ({ ...values })),
    set: vi.fn(async (items) => { Object.assign(values, items); }),
    remove: vi.fn(async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
}

describe("server configuration store", () => {
  it("uses the packaged production URL when no override exists", async () => {
    const area = storage();
    const store = new ServerConfigStore(area, "https://api.palladin.io");

    expect(await store.initialize()).toBe("https://api.palladin.io");
    expect(store.apiUrl).toBe("https://api.palladin.io");
  });

  it("loads and normalizes a non-secret persisted override", async () => {
    const store = new ServerConfigStore(
      storage({ [SERVER_CONFIG_KEY]: "https://vault.example.com/palladin/" }),
      "https://api.palladin.io",
    );

    expect(await store.initialize()).toBe("https://vault.example.com/palladin");
  });

  it("removes an invalid persisted value and fails closed to the packaged URL", async () => {
    const area = storage({ [SERVER_CONFIG_KEY]: "http://attacker.example.com" });
    const store = new ServerConfigStore(area, "https://api.palladin.io");

    expect(await store.initialize()).toBe("https://api.palladin.io");
    expect(area.remove).toHaveBeenCalledWith(SERVER_CONFIG_KEY);
  });

  it("publishes a new value only after durable storage succeeds", async () => {
    const area = storage();
    vi.mocked(area.set).mockRejectedValueOnce(new Error("disk full"));
    const store = new ServerConfigStore(area, "https://api.palladin.io");

    await expect(store.save("https://vault.example.com")).rejects.toThrow("disk full");
    expect(store.apiUrl).toBe("https://api.palladin.io");

    await expect(store.save("https://vault.example.com/")).resolves
      .toBe("https://vault.example.com");
    expect(store.apiUrl).toBe("https://vault.example.com");
  });
});
