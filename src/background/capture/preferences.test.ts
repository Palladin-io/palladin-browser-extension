import { beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_PREFERENCES_KEY, CapturePreferenceStore } from "./preferences";

const account = { vaultId: "vault-1234", entryId: "entry-1234", revision: "4", origin: "https://accounts.example.com" };

describe("capture preferences", () => {
  let records: Record<string, unknown>;
  let store: CapturePreferenceStore;
  beforeEach(() => {
    records = {};
    store = new CapturePreferenceStore({
      get: async () => structuredClone(records),
      set: async (values) => { records = structuredClone(values); },
    });
  });
  it("defaults to asking and isolates profiles", async () => {
    expect(await store.isAutomatic("first", account)).toBe(false);
    await store.setAutomatic("first", account, true);
    expect(await store.isAutomatic("first", account)).toBe(true);
    expect(await store.isAutomatic("other", account)).toBe(false);
  });
  it("never persists credential values or display labels passed alongside a binding", async () => {
    const enriched = { ...account, password: "secret-password", username: "alice", label: "Sensitive account" };
    await store.setAutomatic("first", enriched, true);
    expect(records[CAPTURE_PREFERENCES_KEY]).toEqual([
      { profileId: "first", mutedSites: [], automaticUpdates: [account] },
    ]);
  });
  it("invalidates opt-in when the account entry changes outside the approved update", async () => {
    await store.setAutomatic("first", account, true);
    expect(await store.isAutomatic("first", { ...account, revision: "5" })).toBe(false);
    expect(await store.isAutomatic("first", { ...account, origin: "https://other.example.com" })).toBe(false);
    expect(await store.isAutomatic("first", { ...account, entryId: "other" })).toBe(false);
    expect(await store.isAutomatic("first", { ...account, vaultId: "other" })).toBe(false);
    await store.setAutomatic("first", { ...account, revision: "5" }, true);
    expect(await store.isAutomatic("first", { ...account, revision: "5" })).toBe(true);
  });
  it("supports disabling a specific account and unmuting a site", async () => {
    await store.setAutomatic("first", account, true);
    await store.disableAutomatic("first", account.vaultId, account.entryId);
    expect(await store.isAutomatic("first", account)).toBe(false);
    await store.mute("first", "example.com");
    expect(await store.isMuted("first", "example.com")).toBe(true);
    await store.unmute("first", "example.com");
    expect(await store.isMuted("first", "example.com")).toBe(false);
  });
  it("serializes updates from multiple tabs without losing settings", async () => {
    await Promise.all([store.mute("first", "one.com"), store.mute("first", "two.com"),
      store.setAutomatic("first", account, true), store.mute("other", "three.com")]);
    expect(await store.getProfile("first")).toEqual({ profileId: "first",
      mutedSites: ["one.com", "two.com"], automaticUpdates: [account] });
    expect(await store.isMuted("other", "three.com")).toBe(true);
  });
  it("ignores malformed stored values", async () => {
    records[CAPTURE_PREFERENCES_KEY] = [null, { profileId: "first", mutedSites: [1, "example.com"],
      automaticUpdates: [null, { ...account, origin: "http://example.com" }, { ...account, revision: "0" }] }];
    expect(await store.getProfile("first")).toEqual({ profileId: "first", mutedSites: ["example.com"], automaticUpdates: [] });
  });
});
