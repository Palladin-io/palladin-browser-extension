import { afterEach, expect, it, vi } from "vitest";
import { SharedUnlockExpiryStore } from "./expiry-store";
import { persistManualSharedUnlockDeadline } from "./manual-checkpoint";
const scope = { apiUrl: "https://api.example.test", accountId: "11111111-1111-4111-8111-111111111111" };
afterEach(() => vi.useRealTimers());
it("returns the existing shorter checkpoint after an ordinary fresh password unlock", async () => {
  const values = {};
  const store = new SharedUnlockExpiryStore({ get: async () => values, set: async items => { Object.assign(values, items); } }, action => action(), () => 100);
  await store.checkpoint(scope, 5, 200);
  const disable = vi.fn();
  expect(await persistManualSharedUnlockDeadline(scope, 5, 900, store, () => {}, disable)).toBe(200);
  expect(disable).not.toHaveBeenCalled();
});
it("disables sharing after storage failure while preserving the ordinary own unlock limit", async () => {
  const store = new SharedUnlockExpiryStore({ get: async () => ({}), set: async () => { throw new Error("unavailable"); } }, action => action(), () => 100);
  const disable = vi.fn();
  expect(await persistManualSharedUnlockDeadline(scope, 5, 200, store, () => {}, disable)).toBe(200);
  expect(disable).toHaveBeenCalledOnce();
});
it("does not keep an own password unlock waiting indefinitely on storage", async () => {
  vi.useFakeTimers();
  const save = vi.fn(() => new Promise<void>(() => {}));
  const store = new SharedUnlockExpiryStore({ get: async () => ({}), set: save }, action => action(), () => 100);
  const disable = vi.fn();
  const pending = persistManualSharedUnlockDeadline(scope, 5, 200, store, () => {}, disable);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toBe(200); expect(disable).toHaveBeenCalledOnce();
});
it("cannot publish or disable a newer own session after a late storage completion", async () => {
  let current = true, release!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const store = new SharedUnlockExpiryStore({ get: async () => ({}), set: save }, action => action(), () => 100);
  const disable = vi.fn();
  const pending = persistManualSharedUnlockDeadline(scope, 5, 200, store, () => { if (!current) throw new Error("own session changed"); }, disable);
  const rejection = expect(pending).rejects.toThrow("own session changed");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  current = false; release(); await rejection;
  expect(disable).not.toHaveBeenCalled();
});
