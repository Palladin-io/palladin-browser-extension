import { SharedUnlockSourceAuthority } from "./source-authority";
import fixtures from "./fixtures/session-api-v1.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSharedUnlockLinkMonitor } from "./link-monitor";
import { SharedUnlockApi } from "./api";
import { SharedUnlockLinkStore } from "./link-store";
import type { SharedUnlockCoordinatorRoute } from "./browser-coordinator";
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import type { SharedUnlockLink } from "./api-types";
const accountId = "11111111-1111-4111-8111-111111111111", linkId = "22222222-2222-4222-8222-222222222222";
const hint: SharedUnlockOperationMessage = { attemptId: "A".repeat(43), payload: { kind: "link-invalidated" } };
const tick = () => vi.advanceTimersByTimeAsync(0);
async function setup(authority?: SharedUnlockSourceAuthority) {
  let values: Record<string, unknown> = {}, failWrite = false;
  const storage = { get: async () => structuredClone(values), set: async (next: Record<string, unknown>) => { if (failWrite) throw new Error("disk"); values = { ...values, ...structuredClone(next) }; }, remove: async () => {} };
  const store = new SharedUnlockLinkStore(storage, () => crypto.randomUUID());
  const scope = { accountId, apiUrl: "https://api.test", webOrigin: "https://web.test", extensionId: "a".repeat(32) };
  await store.adopt(scope, linkId);
  const state = { unlocked: true, generation: 1, sequence: 7,
    link: { linkId, revision: 2, epoch: 2, state: "active", lastInvalidationSequence: 0, lastLogoutSequence: 0 } as SharedUnlockLink };
  const listeners = new Set<(message: SharedUnlockOperationMessage) => void>(), watchers = new Set<() => void>();
  const routeAbort = new AbortController();
  const route: SharedUnlockCoordinatorRoute = { ...scope, documentBinding: "own-document", signal: routeAbort.signal,
    assertCurrent: () => { if (routeAbort.signal.aborted) throw new Error("retired"); }, verifyCurrent: async () => { route.assertCurrent(); },
    close: () => routeAbort.abort(), sendOperation: vi.fn(), onOperation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(state.link)));
  const disposed = vi.fn();
  const closeSession = vi.fn(async () => { state.unlocked = false; state.generation++; for (const changed of watchers) changed(); });
  const monitor = startSharedUnlockLinkMonitor(route, {
    nonce: async () => "A".repeat(43), subscribe: listener => { watchers.add(listener); return () => { watchers.delete(listener); }; },
    capture: () => {
      if (!state.unlocked) return null;
      const witness = authority?.closingWitness();
      if (authority && !witness) return null;
      const generation = state.generation, abort = new AbortController();
      return { session: { apiUrl: scope.apiUrl, userId: accountId, accessToken: "own-access", refreshToken: "own-refresh" },
        sequence: witness?.sequence ?? state.sequence, signal: abort.signal, dispose: () => { disposed(); abort.abort(); },
        assertCurrent: () => { if ((authority && authority.closingWitness()?.authorizationId !== witness?.authorizationId) || !state.unlocked || state.generation !== generation) throw new Error("own changed"); } };
    }, closeSession,
  }, store, new SharedUnlockApi(fetcher, () => scope.apiUrl));
  return { state, route, store, scope, fetcher, closeSession, disposed, failWrite: () => { failWrite = true; },
    emit: () => { for (const listener of listeners) listener(hint); }, close: () => { monitor.close(); route.close(); }, watchers, listeners };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { const pending = vi.getTimerCount(); vi.useRealTimers(); expect(pending).toBe(0); });

describe("installed own root repair after a peer hint", () => {
  it.each(["lock", "logout"] as const)("applies own authenticated %s barrier and never echoes a mutation", async action => {
    const f = await setup(); await tick();
    expect(f.closeSession).not.toHaveBeenCalled();
    f.state.link = { ...f.state.link, revision: 3, epoch: 3, state: "locked", lastInvalidationSequence: 8, lastLogoutSequence: action === "logout" ? 8 : 0 };
    f.emit(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.closeSession).toHaveBeenCalledExactlyOnceWith(action);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(f.fetcher.mock.calls[1][1]).toMatchObject({ headers: { authorization: "Bearer own-access" } });
    f.close(); expect(f.watchers.size + f.listeners.size).toBe(0);
  });
  it("does not treat a peer hint as authority to close a newer manual root", async () => {
    const f = await setup(); f.state.generation++; f.state.sequence = 9; f.state.link = { ...f.state.link, lastInvalidationSequence: 8 };
    f.emit(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.closeSession).not.toHaveBeenCalled(); f.close();
  });
  it("rejects an old in-flight response after the own manual generation changes", async () => {
    const f = await setup(); let resolve!: (r: Response) => void;
    f.fetcher.mockImplementation(() => new Promise(r => { resolve = r; }));
    await tick(); f.state.generation++; f.state.sequence = 9;
    resolve(new Response(JSON.stringify({ ...f.state.link, lastLogoutSequence: 8, lastInvalidationSequence: 8 })));
    await tick(); expect(f.closeSession).not.toHaveBeenCalled(); f.close();
  });
  it("repairs a missed hint through the bounded foreground interval", async () => {
    const f = await setup(); await tick(); f.state.link = { ...f.state.link, lastInvalidationSequence: 8 };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.closeSession).toHaveBeenCalledExactlyOnceWith("lock"); f.close();
  });
  it("coalesces a peer hint flood without a request per frame", async () => {
    const f = await setup(); await tick();
    for (let i = 0; i < 100; i++) f.emit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.fetcher).toHaveBeenCalledTimes(2); f.close();
  });
  it("wipes before a failed durable observation and does not undo the local close", async () => {
    const f = await setup(); await tick(); f.failWrite(); f.state.link = { ...f.state.link, lastInvalidationSequence: 8 };
    f.emit(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.unlocked).toBe(false); expect(f.closeSession).toHaveBeenCalledOnce(); f.close();
  });
  it("keeps the independent own session when the browser route closes during a request", async () => {
    const f = await setup(); let resolve!: (r: Response) => void;
    f.fetcher.mockImplementation(() => new Promise(r => { resolve = r; }));
    await tick(); f.close(); resolve(new Response(JSON.stringify({ ...f.state.link, lastInvalidationSequence: 8 })));
    await tick(); expect(f.closeSession).not.toHaveBeenCalled(); expect(f.state.unlocked).toBe(true);
  });
  it("accepts only a value-free invalidation payload", () => {
    expect(sharedUnlockOperationSchema.safeParse(hint).success).toBe(true);
    expect(sharedUnlockOperationSchema.safeParse({ ...hint, payload: { ...hint.payload, action: "logout", accountId } }).success).toBe(false);
  });
});


it.each(["lock", "logout"] as const)("still repairs %s after sharing authority expired in a live own session", async action => {
  const root = { ...fixtures.operations[0].sourceAuthorization, accountId, sequence: 7 };
  let now = root.unlockedAtMs + 1;
  const authority = new SharedUnlockSourceAuthority(new SharedUnlockApi(vi.fn<typeof fetch>(), () => "https://api.test"), () => now);
  authority.adopt(root, "A".repeat(43), { sharedUnlockEnabled: true, revision: 1 }, () => {});
  const f = await setup(authority); await tick();
  now = root.idleDeadlineMs;
  expect(authority.snapshot().authorization).toBeNull();
  expect(() => authority.captureActivity()).toThrow();
  f.state.link = { ...f.state.link, revision: 3, epoch: 3, state: "locked", lastInvalidationSequence: 8, lastLogoutSequence: action === "logout" ? 8 : 0 };
  f.emit(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.closeSession).toHaveBeenCalledExactlyOnceWith(action);
  expect(f.fetcher.mock.calls[1][1]).toMatchObject({ headers: { authorization: "Bearer own-access" } });
  expect(authority.snapshot().authorization).toBeNull();
  f.close();
});
