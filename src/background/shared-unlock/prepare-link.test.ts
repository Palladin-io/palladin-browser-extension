import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_KDF_PROFILE_ID, toBase64Url } from "@palladin/crypto";
import { AuthClient } from "../session/auth-client";
import { AutoLock } from "../session/auto-lock";
import { SessionManager } from "../session/session-manager";
import { SessionStore } from "../session/session-store";
import { FakeAlarms, FakeStorageArea } from "../session/test-support";
import { SharedUnlockApi } from "./api";
import { SharedUnlockSourceAuthority } from "./source-authority";
import { SharedUnlockLinkStore } from "./link-store";
import { prepareSharedUnlockLink } from "./prepare-link";
import type { SharedUnlockLink } from "./api-types";
import fixtures from "./fixtures/session-api-v1.json";

const root = fixtures.operations[0].sourceAuthorization;
const apiUrl = "https://api.example.test";
const scope = { apiUrl, webOrigin: "https://web.example.test", extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", accountId: root.accountId };
const linkId = "22222222-2222-4222-8222-222222222222";
const locked: SharedUnlockLink = { linkId, revision: 1, epoch: 1, state: "locked", lastInvalidationSequence: 0, lastLogoutSequence: 0 };
const active: SharedUnlockLink = { ...locked, revision: 2, epoch: 2, state: "active" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const cleanups: (() => void)[] = [];
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(root.unlockedAtMs + 1); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(options: { pause?: string; fail?: string } = {}) {
  const state = { enabled: true, preferenceRevision: 3, serverLink: null as SharedUnlockLink | null, prepared: false };
  const tokens = { apiUrl, userId: root.accountId, accessToken: "own-access", refreshToken: "own-refresh" };
  const pending = deferred<Response>(); const events: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer own-access");
    const suffix = String(url).split("/").at(-1)!;
    const action = suffix === "shared-unlock" ? "preference" : suffix === linkId ? "read-link" : suffix;
    if (state.prepared) events.push(action);
    if (state.prepared && options.pause === action) return pending.promise;
    if (state.prepared && options.fail === action) return response({}, 503);
    if (action === "preference") return response({ sharedUnlockEnabled: state.enabled, revision: state.preferenceRevision });
    if (action === "authorizations") return response(root);
    if (action === "read-link") return state.serverLink ? response(state.serverLink) : response({}, 404);
    if (action === "links") {
      expect(JSON.parse(String(init?.body))).toEqual({ linkId, expectedPreferenceRevision: 3 });
      state.serverLink = locked; return response(locked);
    }
    if (action === "activate") {
      expect(JSON.parse(String(init?.body))).toEqual({ authorizationId: root.authorizationId, refreshToken: tokens.refreshToken,
        sourceGeneration: authority.snapshot().sourceGeneration, expectedRevision: state.serverLink!.revision, expectedPreferenceRevision: 3 });
      state.serverLink = active; return response(active);
    }
    throw new Error("unexpected request");
  });
  const storage = new FakeStorageArea(); const store = new SharedUnlockLinkStore(storage, () => linkId);
  const sessionStore = new SessionStore(storage);
  let manager: SessionManager;
  manager = new SessionManager({ store: sessionStore, authClient: new AuthClient(fetcher, () => apiUrl),
    autoLock: new AutoLock(new FakeAlarms(), () => { void manager.lock(); }) });
  const material = { accountId: root.accountId, encryptedPrivateKey: toBase64Url(new Uint8Array(64)),
    kdf: { securityVersion: 1, minimumSecurityVersion: 1, profileId: IDENTITY_KDF_PROFILE_ID, kdfSalt: toBase64Url(new Uint8Array(16)) } };
  await (await manager.beginSharedUnlockInstall(root.accountId, apiUrl, () => {})).install({ tokens, material,
    keys: { masterKey: new Uint8Array(32).fill(7), privateKey: new Uint8Array(32).fill(8) }, limits: root });
  const api = new SharedUnlockApi(fetcher, () => apiUrl);
  const authority = new SharedUnlockSourceAuthority(api, () => Date.now());
  await authority.prepare({ tokens, account: { userId: root.accountId, email: "synthetic@example.test", kdf: { ...material.kdf,
    credentialRevision: root.credentialRevision, privateKeyWrapRevision: root.privateKeyWrapRevision, deviceWrapperMetadata: null } },
    authCredential: new Uint8Array(32).fill(17), limits: root, assertCurrent: () => {} });
  state.prepared = true;
  const abort = new AbortController();
  const verify = vi.fn(async () => {});
  const input = { scope, organizationId: root.organizationId, signal: abort.signal, verifyBrowser: verify,
    assertCurrent: () => { if (abort.signal.aborted) throw new Error("route gone"); } };
  cleanups.push(() => { abort.abort(); void manager.lock(); authority.reset(); });
  return { state, store, storage, manager, api, authority, abort, verify, input, pending, events, fetcher,
    run: () => prepareSharedUnlockLink(input, manager, authority, api, store) };
}

describe("fresh own Identity preparation of a durable local link", () => {
  it("persists one ID before creating/binding and leaves own session/root/limits unchanged", async () => {
    const f = await setup(); const keys = f.manager.getKeys(); const limits = f.manager.getSharedUnlockLimits();
    const rootBefore = f.authority.snapshot();
    expect(await f.run()).toEqual({ link: active, preference: rootBefore.preference, sourceGeneration: rootBefore.sourceGeneration });
    expect(f.events).toEqual(["preference", "read-link", "links", "activate"]);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect((await f.store.read(scope))!.observed).toEqual(active);
    expect(f.authority.snapshot()).toEqual(rootBefore);
    expect(f.manager.getKeys()).toBe(keys); expect(f.manager.getSharedUnlockLimits()).toEqual(limits);
  });
  it("reads and binds an existing link without manufacturing a replacement", async () => {
    const f = await setup(); await f.store.ensure(scope); f.state.serverLink = active;
    await f.run(); expect(f.events).toEqual(["preference", "read-link", "activate"]);
  });
  it("keeps explicit OFF and performs no link mutation or allocation", async () => {
    const f = await setup(); f.state.enabled = false; f.state.preferenceRevision = 4;
    await expect(f.run()).rejects.toMatchObject({ reason: "disabled" });
    expect(f.events).toEqual(["preference"]); expect(await f.store.read(scope)).toBeNull();
    expect(f.authority.snapshot().preference).toEqual({ sharedUnlockEnabled: false, revision: 4 });
    expect(f.manager.getKeys()).not.toBeNull();
  });
  it("a failed preference read never infers ON or allocates a link", async () => {
    const f = await setup({ fail: "preference" });
    await expect(f.run()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.events).toEqual(["preference"]); expect(await f.store.read(scope)).toBeNull();
  });
  for (const action of ["lock", "logout", "disconnect"] as const) {
    it(`refuses a persisted pending ${action} before reading or activating the link`, async () => {
      const f = await setup(); await f.store.ensure(scope); await f.store.beginClosing(scope, linkId, action, 1, 3);
      await expect(f.run()).rejects.toMatchObject({ reason: "pending-closing" });
      expect(f.events).toEqual(["preference"]);
    });
  }
  it("does not bypass locally retained disconnection with an active server response", async () => {
    const f = await setup(); await f.store.ensure(scope); await f.store.observe(scope, { ...locked, revision: 5, state: "revoked" });
    f.state.serverLink = { ...active, revision: 6 };
    await f.store.observe(scope, f.state.serverLink);
    await expect(f.run()).rejects.toMatchObject({ reason: "disconnected" });
    expect(f.events).toEqual(["preference"]);
  });
  it("persists an authoritative revoked result and never activates it", async () => {
    const f = await setup(); f.state.serverLink = { ...locked, revision: 5, state: "revoked" };
    await expect(f.run()).rejects.toMatchObject({ reason: "disconnected" });
    expect(f.events).toEqual(["preference", "read-link"]);
    expect((await f.store.read(scope))!.observed!.state).toBe("revoked");
  });
  it("does not recreate a previously observed link that Identity no longer returns", async () => {
    const f = await setup(); await f.store.ensure(scope); await f.store.observe(scope, active);
    await expect(f.run()).rejects.toMatchObject({ reason: "missing-link" });
    expect(f.events).toEqual(["preference", "read-link"]);
    expect((await f.store.read(scope))!.linkId).toBe(linkId);
  });
  it("retains the allocated ID after a create failure", async () => {
    const f = await setup({ fail: "links" });
    await expect(f.run()).rejects.toMatchObject({ code: "unavailable" });
    expect((await f.store.read(scope))!.linkId).toBe(linkId);
    await expect(f.run()).rejects.toThrow();
    expect((await f.store.read(scope))!.linkId).toBe(linkId);
  });
  for (const action of ["route", "lock", "root"] as const) {
    it(`refuses late activation after ${action}`, async () => {
      const f = await setup({ pause: "activate" });
      const pending = f.run(); const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(f.events).toContain("activate"));
      if (action === "route") f.abort.abort();
      if (action === "lock") await f.manager.lock();
      if (action === "root") f.authority.reset();
      if (action !== "root") await rejected;
      f.pending.resolve(response(active)); await rejected;
      expect(f.verify).toHaveBeenCalledOnce();
      expect((await f.store.read(scope))!.observed).toEqual(locked);
    });
  }
  it("a closing intent arriving during activation prevents readiness", async () => {
    const f = await setup({ pause: "activate" });
    const pending = f.run(); const rejected = expect(pending).rejects.toMatchObject({ reason: "pending-closing" });
    await vi.waitFor(() => expect(f.events).toContain("activate"));
    await f.store.beginClosing(scope, linkId, "logout", 1, 3);
    f.pending.resolve(response(active)); await rejected;
    expect((await f.store.read(scope))!.pending[0]!.action).toBe("logout");
  });
  for (const action of ["off", "pending", "new-barrier"] as const) {
    it(`checks ${action} again after the final browser await`, async () => {
      const f = await setup();
      f.verify.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
        if (action === "off") f.authority.acceptPreference({ sharedUnlockEnabled: false, revision: 4 }, f.authority.snapshot().sourceGeneration!);
        if (action === "pending") await f.store.beginClosing(scope, linkId, "logout", 2, 3);
        if (action === "new-barrier") await f.store.observe(scope, { ...active, revision: 9, epoch: 9, state: "locked", lastInvalidationSequence: 8 });
      });
      await expect(f.run()).rejects.toThrow();
    });
  }
  it("enforces elapsed time even if the timeout callback has not run", async () => {
    const f = await setup({ pause: "activate" });
    const pending = f.run(); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.events).toContain("activate"));
    vi.mocked(Date.now).mockReturnValue(root.unlockedAtMs + 31_001);
    f.pending.resolve(response(active)); await rejected;
    expect(f.verify).toHaveBeenCalledOnce();
  });

  it("bounds a stalled browser check without a heartbeat lease on the own session", async () => {
    const f = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.verify.mockImplementation(() => new Promise<void>(() => {}));
    const pending = f.run(); const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(f.events).toEqual([]); expect(f.manager.getKeys()).not.toBeNull();
  });
});
