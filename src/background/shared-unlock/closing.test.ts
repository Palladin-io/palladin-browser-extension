import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedUnlockApi } from "./api";
import { deliverSharedUnlockClosings, flushSharedUnlockClosings, subscribeSharedUnlockLinkChanges } from "./closing";
import { SharedUnlockLinkStore } from "./link-store";
import type { SharedUnlockLink } from "./api-types";

const scope = { accountId: "11111111-1111-4111-8111-111111111111", apiUrl: "https://api.test", webOrigin: "https://web.test", extensionId: "a".repeat(32) };
const session = { userId: scope.accountId, apiUrl: scope.apiUrl, accessToken: "own-access", refreshToken: "own-refresh" };
const linkId = "22222222-2222-4222-8222-222222222222";
const initial: SharedUnlockLink = { linkId, revision: 7, epoch: 4, state: "active", lastInvalidationSequence: 2, lastLogoutSequence: 0 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function setup(action: "lock" | "logout" = "lock") {
  let values: Record<string, unknown> = {};
  const storage = { get: async () => structuredClone(values), set: async (next: Record<string, unknown>) => { values = { ...values, ...structuredClone(next) }; },
    remove: async (keys: string[]) => { for (const key of keys) delete values[key]; } };
  const store = new SharedUnlockLinkStore(storage, () => crypto.randomUUID());
  await store.adopt(scope, linkId); await store.recordManualClosing(scope, action);
  const current = { link: { ...initial }, enabled: true, conflict: false };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("shared-unlock")) return response({ sharedUnlockEnabled: current.enabled, revision: 5 });
    if (init?.method === "GET") return response(current.link);
    if (current.conflict) return response({}, 409);
    const action = String(url).split("/").at(-1);
    current.link = { ...current.link, revision: current.link.revision + 1, epoch: current.link.epoch + 1,
      state: action === "disconnect" || current.link.state === "revoked" ? "revoked" : "locked", lastInvalidationSequence: 8,
      lastLogoutSequence: action === "logout" ? 8 : current.link.lastLogoutSequence };
    return response(current.link);
  });
  const api = new SharedUnlockApi(fetcher, () => scope.apiUrl);
  return { store, api, fetcher, current, run: (check = () => {}) => flushSharedUnlockClosings(scope, session, store, api, new AbortController().signal, check) };
}
afterEach(() => vi.useRealTimers());

describe("own Identity closing delivery", () => {
  it.each(["lock", "logout"] as const)("delivers %s with fresh own CAS and settles only after its receipt", async action => {
    const f = await setup(action), hint = vi.fn(); const unsubscribe = subscribeSharedUnlockLinkChanges(hint);
    try {
      await f.run();
      const [url, init] = f.fetcher.mock.calls[2];
      expect(url).toBe(`${scope.apiUrl}/api/account/shared-unlock/links/${linkId}/${action}`);
      expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer own-access" }, credentials: "omit", redirect: "error", cache: "no-store" });
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 7, expectedPreferenceRevision: 5 });
      expect((await f.store.read(scope))!.pending).toEqual([]);
      expect(hint).toHaveBeenCalledWith({ accountId: scope.accountId, apiUrl: scope.apiUrl, linkId });
      expect(JSON.stringify(hint.mock.calls)).not.toContain("own-access");
    } finally { unsubscribe(); }
  });
  it("settles manual propagation while OFF without a mutation or removing disconnect", async () => {
    const f = await setup("logout"); f.current.enabled = false;
    await f.store.beginClosing(scope, linkId, "disconnect", 7, null);
    await f.run();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url).split("/").at(-1))).toEqual(["disconnect"]);
    expect((await f.store.read(scope))!.disconnectId).not.toBeNull();
  });
  it("retains a conflicting action without mutation retry or a false acknowledgement", async () => {
    const f = await setup(); f.current.conflict = true;
    await expect(f.run()).rejects.toThrow();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await f.store.read(scope))!.pending).toMatchObject([{ action: "lock" }]);
  });
  it("does not erase a stronger logout introduced while lock delivery was in flight", async () => {
    const f = await setup(); const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/lock")) await f.store.recordManualClosing(scope, "logout");
      return original(url, init);
    });
    await expect(f.run()).rejects.toThrow();
    expect((await f.store.read(scope))!.pending).toMatchObject([{ action: "logout" }]);
  });
  it("rejects an account/environment mismatch before reading or sending own tokens", async () => {
    const f = await setup();
    await expect(flushSharedUnlockClosings({ ...scope, accountId: "other" }, session, f.store, f.api, new AbortController().signal, () => {})).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("cancels delivery at two seconds even if fetch ignores abort, retaining the intent", async () => {
    vi.useFakeTimers(); const f = await setup();
    let resolve!: (value: Response) => void;
    f.fetcher.mockImplementation(() => new Promise(r => { resolve = r; }));
    const sent = deliverSharedUnlockClosings([scope], session, f.store, f.api, () => {});
    await vi.advanceTimersByTimeAsync(2000); await sent;
    resolve(response({ sharedUnlockEnabled: true, revision: 5 })); await Promise.resolve();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect((await f.store.read(scope))!.pending).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});


it("settles logout of a revoked link without removing its explicit reconnect latch", async () => {
  const f = await setup("logout");
  f.current.link = { ...f.current.link, state: "revoked", lastInvalidationSequence: 7 };
  const before = await f.store.observe(scope, f.current.link);
  expect(before.disconnectId).not.toBeNull();
  await f.run();
  const marker = await f.store.read(scope);
  expect(marker).toMatchObject({ pending: [], disconnectId: before.disconnectId,
    observed: { state: "revoked", lastLogoutSequence: 8, lastInvalidationSequence: 8 } });
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url).split("/").at(-1))).toEqual(["logout"]);
});
