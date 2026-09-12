import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../session/session-store";
import { FakeStorageArea } from "../session/test-support";
import { SharedUnlockLinkStore, type SharedUnlockLinkScope } from "./link-store";
import type { SharedUnlockLink } from "./api-types";

const scope: SharedUnlockLinkScope = { apiUrl: "https://api.test", webOrigin: "https://web.test",
  extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", accountId: "11111111-1111-4111-8111-111111111111" };
const linkId = "22222222-2222-4222-8222-222222222222";
const link: SharedUnlockLink = { linkId, revision: 2, epoch: 1, state: "active", lastInvalidationSequence: 0, lastLogoutSequence: 0 };
function setup() {
  const storage = new FakeStorageArea(); let sequence = 1;
  const ids = vi.fn(() => sequence++ === 1 ? linkId : `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`);
  return { storage, ids, store: new SharedUnlockLinkStore(storage, ids) };
}

describe("durable nonsensitive shared-unlock local link", () => {
  it("allocates once under concurrent calls and retains the ID across worker restarts", async () => {
    const f = setup();
    const [first, second] = await Promise.all([f.store.ensure(scope), f.store.ensure(scope)]);
    expect(first.linkId).toBe(linkId); expect(second).toEqual(first); expect(f.ids).toHaveBeenCalledOnce();
    const restarted = new SharedUnlockLinkStore(f.storage, () => { throw new Error("must reuse"); });
    expect(await restarted.ensure(scope)).toEqual(first);
  });
  it("retains revocation and pending logout when ordinary session logout clears its own storage", async () => {
    const f = setup(); await f.store.ensure(scope);
    await f.store.observe(scope, { ...link, revision: 8, state: "revoked", lastInvalidationSequence: 7, lastLogoutSequence: 6 });
    const marker = await f.store.beginClosing(scope, linkId, "logout", 8, 3);
    await new SessionStore(f.storage).clearAll();
    const restarted = new SharedUnlockLinkStore(f.storage);
    expect(await restarted.ensure(scope)).toEqual(marker);
    expect(f.ids).toHaveBeenCalledTimes(3);
  });
  for (const field of ["apiUrl", "webOrigin", "extensionId", "accountId"] as const) {
    it(`partitions the local record by ${field}`, async () => {
      const f = setup(); await f.store.ensure(scope);
      expect(await f.store.read({ ...scope, [field]: "different" })).toBeNull();
    });
  }
  it("does not silently replace an existing link when adopting a peer hint", async () => {
    const f = setup(); await f.store.ensure(scope);
    await expect(f.store.adopt(scope, "44444444-4444-4444-8444-444444444444")).rejects.toThrow();
    expect((await f.store.read(scope))!.linkId).toBe(linkId);
    expect(await f.store.adopt(scope, linkId)).toEqual(await f.store.read(scope));
  });
  it("adopts an independently chosen initial link without generating another ID", async () => {
    const f = setup(); await f.store.adopt(scope, linkId);
    expect((await f.store.read(scope))!.linkId).toBe(linkId); expect(f.ids).not.toHaveBeenCalled();
  });
  it("retains logout plus disconnect and never downgrades logout to a repeated lock", async () => {
    const f = setup(); await f.store.ensure(scope);
    await f.store.beginClosing(scope, linkId, "lock", 2, 3);
    const logout = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    await f.store.beginClosing(scope, linkId, "disconnect", 2, null);
    const marker = await f.store.beginClosing(scope, linkId, "lock", 2, 3);
    expect(marker.pending.map(intent => intent.action)).toEqual(["logout", "disconnect"]);
    expect(marker.pending[0]).toEqual(logout.pending[0]);
    expect(await f.store.beginClosing(scope, linkId, "disconnect", 2, null)).toEqual(marker);
  });
  it("retains a later logout even when disconnect was requested first", async () => {
    const f = setup(); await f.store.ensure(scope);
    const disconnect = await f.store.beginClosing(scope, linkId, "disconnect", 2, null);
    const marker = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    expect(marker.pending.map(intent => intent.action)).toEqual(["logout", "disconnect"]);
    expect(marker.pending[1]).toEqual(disconnect.pending[0]);
  });
  it("an old lock receipt cannot clear a newer logout or regress an observed revocation", async () => {
    const f = setup(); await f.store.ensure(scope);
    const locked = await f.store.beginClosing(scope, linkId, "lock", 2, 3);
    const logout = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    const revoked = { ...link, revision: 8, state: "revoked" as const, lastInvalidationSequence: 9, lastLogoutSequence: 9 };
    await f.store.observe(scope, revoked);
    const result = await f.store.acknowledgeClosing(scope, linkId, locked.pending[0]!.id, { ...link, revision: 3, state: "locked" });
    expect(result.pending).toEqual(logout.pending); expect(result.observed).toEqual(revoked);
    const acknowledged = await f.store.acknowledgeClosing(scope, linkId, logout.pending[0]!.id, revoked);
    expect(acknowledged.pending).toEqual([]); expect(acknowledged.observed).toEqual(revoked);
  });
  it("a successful logout receipt leaves the separate pending disconnect", async () => {
    const f = setup(); await f.store.ensure(scope);
    const logout = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    await f.store.beginClosing(scope, linkId, "disconnect", 2, null);
    const result = await f.store.acknowledgeClosing(scope, linkId, logout.pending[0]!.id, { ...link, revision: 3, state: "locked" });
    expect(result.pending.map(intent => intent.action)).toEqual(["disconnect"]);
  });
  it("projects only known nonsensitive fields from a first-party response", async () => {
    const f = setup(); await f.store.ensure(scope);
    await f.store.observe(scope, { ...link, futureSession: "must-not-persist" } as SharedUnlockLink);
    expect(JSON.stringify(f.storage.values())).not.toContain("must-not-persist");
    expect((await f.store.read(scope))!.observed).toEqual(link);
  });
  it("does not erase a pending intent just because an authoritative read is active", async () => {
    const f = setup(); await f.store.ensure(scope);
    const marker = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    expect((await f.store.observe(scope, { ...link, revision: 5 })).pending).toEqual(marker.pending);
  });
  for (const corruption of ["null", "version", "account", "observed-link", "extra", "duplicate-intent"] as const) {
    it(`treats persisted ${corruption} as unavailable, never as first use`, async () => {
      const f = setup(); await f.store.ensure(scope);
      const marker = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
      const bad = corruption === "null" ? null
        : corruption === "version" ? { ...marker, version: 99 }
        : corruption === "account" ? { ...marker, accountId: "55555555-5555-4555-8555-555555555555" }
        : corruption === "observed-link" ? { ...marker, observed: { ...link, linkId: "55555555-5555-4555-8555-555555555555" } }
        : corruption === "extra" ? { ...marker, extra: "unknown" }
        : { ...marker, pending: [marker.pending[0], marker.pending[0]] };
      await f.storage.set({ [f.storage.keys()[0]!]: bad });
      const count = f.ids.mock.calls.length;
      await expect(f.store.ensure(scope)).rejects.toThrow();
      expect(f.ids).toHaveBeenCalledTimes(count);
      expect(f.storage.values()).toEqual([bad]);
    });
  }
  it("does not lose queued closing intent while an earlier observation write is stalled", async () => {
    const f = setup(); await f.store.ensure(scope);
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const write = f.storage.set.bind(f.storage);
    vi.spyOn(f.storage, "set").mockImplementationOnce(async values => { await paused; await write(values); });
    const observed = f.store.observe(scope, link);
    const closing = f.store.beginClosing(scope, linkId, "logout", 2, 3);
    resume(); await observed; const result = await closing;
    expect(result.pending[0]!.action).toBe("logout");
    expect((await f.store.read(scope))!.pending).toEqual(result.pending);
  });
  it("a later active server observation never silently reconnects a disconnected local client", async () => {
    const f = setup(); await f.store.ensure(scope);
    const revoked = await f.store.observe(scope, { ...link, revision: 8, state: "revoked" });
    const later = await f.store.observe(scope, { ...link, revision: 10 });
    expect(later.disconnectId).toBe(revoked.disconnectId);
    expect(later.disconnectId).not.toBeNull();
    expect((await new SharedUnlockLinkStore(f.storage).read(scope))!.disconnectId).toBe(revoked.disconnectId);
  });
  it("only an explicit reconnect receipt clears its local disconnect latch", async () => {
    const f = setup(); await f.store.ensure(scope);
    const revoked = await f.store.observe(scope, { ...link, revision: 8, state: "revoked" });
    const reconnected = await f.store.acknowledgeReconnect(scope, linkId, revoked.disconnectId!, { ...link, revision: 9, epoch: 9, state: "locked" });
    expect(reconnected.disconnectId).toBeNull();
    expect(reconnected.observed!.state).toBe("locked");
    const stale = await f.store.observe(scope, { ...link, revision: 8, state: "revoked" });
    expect(stale.disconnectId).toBeNull();
    expect(stale.observed).toEqual(reconnected.observed);
  });
  for (const action of ["lock", "disconnect"] as const) {
    it(`a later ${action} prevents an old reconnect receipt from clearing the latch`, async () => {
      const f = setup(); await f.store.ensure(scope);
      const revoked = await f.store.observe(scope, { ...link, revision: 8, state: "revoked" });
      const closing = await f.store.beginClosing(scope, linkId, action, 8, 3);
      if (action === "disconnect") await f.store.acknowledgeClosing(scope, linkId, closing.pending[0]!.id, { ...link, revision: 10, state: "revoked" });
      await expect(f.store.acknowledgeReconnect(scope, linkId, revoked.disconnectId!, { ...link, revision: 9, state: "locked" })).rejects.toThrow();
      expect((await f.store.read(scope))!.disconnectId).not.toBeNull();
    });
  }

  it("retains a stronger logout while repairing an earlier failed lock write", async () => {
    const f = setup(); await f.store.ensure(scope);
    vi.spyOn(f.storage, "set").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.store.beginClosing(scope, linkId, "lock", 2, 3)).rejects.toThrow();
    const repaired = await f.store.beginClosing(scope, linkId, "logout", 2, 3);
    expect(repaired.pending.map(intent => intent.action)).toEqual(["logout"]);
    expect(await f.store.read(scope)).toEqual(repaired);
  });
  it("retains an observed revocation when its persistence fails", async () => {
    const f = setup(); await f.store.ensure(scope); await f.store.observe(scope, link);
    vi.spyOn(f.storage, "set").mockRejectedValueOnce(new Error("disk unavailable"));
    const revoked = { ...link, revision: 9, state: "revoked" as const };
    await expect(f.store.observe(scope, revoked)).rejects.toThrow();
    await expect(f.store.read(scope)).rejects.toThrow();
    await f.store.repair(scope);
    expect((await f.store.read(scope))!.observed).toEqual(revoked);
  });
  it("keeps a failed initial allocation for repair instead of allocating a replacement", async () => {
    const f = setup(); vi.spyOn(f.storage, "set").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.store.ensure(scope)).rejects.toThrow();
    await expect(f.store.ensure(scope)).rejects.toThrow();
    await f.store.repair(scope);
    expect((await f.store.ensure(scope)).linkId).toBe(linkId);
    expect(f.ids).toHaveBeenCalledOnce();
  });
  it("a failed closing write prevents further sharing until the exact pending decision is durably repaired", async () => {
    const f = setup(); await f.store.ensure(scope);
    vi.spyOn(f.storage, "set").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.store.beginClosing(scope, linkId, "logout", 2, 3)).rejects.toThrow("disk unavailable");
    await expect(f.store.read(scope)).rejects.toThrow();
    await expect(f.store.ensure(scope)).rejects.toThrow();
    await f.store.repair(scope);
    expect((await f.store.read(scope))!.pending[0]!.action).toBe("logout");
  });
});
