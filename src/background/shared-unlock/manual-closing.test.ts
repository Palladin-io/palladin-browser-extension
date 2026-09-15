import { describe, expect, it } from "vitest";
import { SharedUnlockLinkStore, type SharedUnlockLinkScope } from "./link-store";

const scope: SharedUnlockLinkScope = { apiUrl: "https://api.test", webOrigin: "https://web.test",
  extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", accountId: "11111111-1111-4111-8111-111111111111" };
const linkId = "22222222-2222-4222-8222-222222222222";
function setup() {
  let values: Record<string, unknown> = {}, fail = false;
  const storage = {
    remove: async (keys: string[]) => { for (const key of keys) delete values[key]; },
    get: async (keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])),
    set: async (items: Record<string, unknown>) => { if (fail) throw new Error("disk"); values = { ...values, ...structuredClone(items) }; },
  };
  const make = () => new SharedUnlockLinkStore(storage, () => crypto.randomUUID());
  return { make, store: make(), fail: (next: boolean) => { fail = next; } };
}

describe("explicit manual shared closing", () => {
  it("does not create a link or close another account when the peer was never linked", async () => {
    const f = setup(); await f.store.adopt(scope, linkId);
    const other = { ...scope, accountId: "33333333-3333-4333-8333-333333333333" };
    expect(await f.store.recordManualClosing(other, "logout")).toBeNull();
    expect((await f.store.read(scope))!.pending).toEqual([]);
    expect(await f.store.read(other)).toBeNull();
  });
  it("records a receiver-only link without inventing an authoritative revision or preference", async () => {
    const f = setup(); await f.store.adopt(scope, linkId);
    const closing = f.store.recordManualClosing(scope, "lock");
    const nextAdmission = f.store.read(scope);
    await closing;
    expect((await nextAdmission)!.pending).toMatchObject([{ action: "lock", expectedRevision: 0, preferenceRevision: null }]);
    expect(await f.make().read(scope)).toEqual(await f.store.read(scope));
  });
  it("retains logout and disconnect after repeated lock and restart", async () => {
    const f = setup(); await f.store.adopt(scope, linkId);
    await f.store.beginClosing(scope, linkId, "disconnect", 3, null);
    await f.store.recordManualClosing(scope, "lock");
    await f.store.recordManualClosing(scope, "logout");
    const before = await f.store.read(scope);
    await f.store.recordManualClosing(scope, "lock");
    const after = await f.make().read(scope);
    expect(after).toEqual(before);
    expect(after!.pending.map(intent => intent.action)).toEqual(["logout", "disconnect"]);
    expect(after!.disconnectId).not.toBeNull();
  });
  it("gates a failed lock write and retains a stronger logout until its exact write succeeds", async () => {
    const f = setup(); await f.store.adopt(scope, linkId); f.fail(true);
    await expect(f.store.recordManualClosing(scope, "lock")).rejects.toThrow("disk");
    await expect(f.store.read(scope)).rejects.toThrow();
    await expect(f.store.recordManualClosing(scope, "logout")).rejects.toThrow("disk");
    f.fail(false); await f.store.recordManualClosing(scope, "lock");
    expect((await f.make().read(scope))!.pending).toMatchObject([{ action: "logout" }]);
  });
});
