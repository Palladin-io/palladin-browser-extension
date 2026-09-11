import type { SharedUnlockInstalled } from "./receiver";
import { receiveSharedUnlockBrowserTransfer, type SharedUnlockOperationTransport } from "./browser-transfer";
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSharedUnlockOffer, encodeSharedUnlockIdentityProof, encryptWithKey, fromBase64Url,
  generateKeyPair, hashSharedUnlockKeyContext, hashSharedUnlockTranscript, loadSodium, randomBytes,
  toBase64Url, sealVaultKey, unsealVaultKey, encryptEntry, decryptEntry, ENTRY_TYPE_KEY,
} from "@palladin/crypto";
import * as keyRecovery from "../../shared/crypto/shared-unlock-keys";
import type { SessionKeys } from "../session/types";
import { AuthClient } from "../session/auth-client";
import { AutoLock } from "../session/auto-lock";
import { SessionHooks } from "../session/hooks";
import { SessionManager } from "../session/session-manager";
import { SessionStore } from "../session/session-store";
import { FakeAlarms, FakeStorageArea } from "../session/test-support";
import { SharedUnlockApi } from "./api";
import { beginSharedUnlockReceiver, type SharedUnlockReceiverRoute } from "./receiver";
import type { SharedUnlockCommit, SharedUnlockOperation } from "./api-types";
import fixtures from "./fixtures/session-api-v1.json";

const apiUrl = "https://api.example.test";
const baseline = fixtures.responses.find(r => r.type === "operation" && r.body.context?.direction === "web-to-extension")!.body as SharedUnlockOperation;
const now = baseline.context.issuedAtMs;
const newSession = { accessToken: "receiver-own-access", refreshToken: "receiver-own-refresh", userId: baseline.context.accountId,
  isOnboarded: true, emailVerified: true, waitlistDeveloperBenefitStartedAt: null, waitlistDeveloperBenefitEndsAt: null };
const cancels: (() => void)[] = [];
beforeAll(async () => { await loadSodium(); });
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { for (const cancel of cancels.splice(0)) cancel(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

async function setup(options: { onInstalled?: SharedUnlockInstalled; pause?: "consume" | "commit";
  transformConsume?: (op: SharedUnlockOperation) => SharedUnlockOperation;
  transformCommit?: (commit: SharedUnlockCommit) => SharedUnlockCommit } = {}) {
  const routeAbort = new AbortController();
  const environment = { value: apiUrl };
  const original = baseline.context;
  let current = true;
  const route: SharedUnlockReceiverRoute = {
    apiUrl, signal: routeAbort.signal, binding: {
      accountId: original.accountId, organizationId: original.organizationId, apiOrigin: apiUrl,
      webOrigin: original.webOrigin, extensionId: original.extensionId, documentBinding: original.documentBinding,
      webGeneration: original.webGeneration, extensionGeneration: original.extensionGeneration,
      linkId: original.linkId, linkEpoch: original.linkEpoch, preferenceRevision: original.preferenceRevision,
    }, assertCurrent: () => { if (!current) throw new Error("route changed"); },
  };
  const pendingResponse = deferred<Response>();
  const events: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    events.push(action);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (action === "logout") {
      expect(String(url)).toBe(`${apiUrl}/api/auth/logout`);
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: newSession.refreshToken });
      return new Response(null, { status: 204 });
    }
    const purpose = action as "consume" | "commit";
    const proof = { operationId: operation.context.operationId, challenge: operation.challenge,
      transcriptHash: operation.transcriptHash, issuedAtMs: operation.context.issuedAtMs, expiresAtMs: operation.context.expiresAtMs };
    const sodium = await loadSodium();
    expect(sodium.crypto_sign_verify_detached(fromBase64Url(JSON.parse(String(init?.body)).signature),
      encodeSharedUnlockIdentityProof(proof, operation.recipientProofPublicKey, purpose), fromBase64Url(operation.recipientProofPublicKey))).toBe(true);
    if (action === options.pause) return pendingResponse.promise;
    return new Response(JSON.stringify(action === "consume" ? (options.transformConsume?.(operation) ?? operation) : (options.transformCommit?.(ownCommit) ?? ownCommit)));
  });
  const storage = new FakeStorageArea();
  const store = new SessionStore(storage);
  const hooks = new SessionHooks();
  let manager: SessionManager;
  const autoLock = new AutoLock(new FakeAlarms(), () => { void manager.lock(); });
  manager = new SessionManager({ store, hooks, autoLock, authClient: new AuthClient(fetcher, () => environment.value) });
  const api = new SharedUnlockApi(fetcher, () => environment.value);
  const receiver = await beginSharedUnlockReceiver(route, manager, api, options.onInstalled);
  cancels.push(receiver.cancel, () => { void manager.lock(); });
  const masterKey = await randomBytes(32);
  const member = await generateKeyPair();
  const source = await createSharedUnlockOffer({ role: "source", assertCurrent: () => {} });
  const keyContext = { ...baseline.keyContext, publicKey: toBase64Url(member.publicKey),
    encryptedPrivateKey: toBase64Url(await encryptWithKey(member.privateKey, masterKey)) };
  const context = { ...original, keyContextDigest: await hashSharedUnlockKeyContext(keyContext) };
  const operation: SharedUnlockOperation = { ...baseline, context, keyContext, sourcePublicKey: source.publicKey,
    recipientPublicKey: receiver.publicKey, recipientProofPublicKey: receiver.proofPublicKey,
    transcriptHash: await hashSharedUnlockTranscript(context, source.publicKey, receiver.publicKey) };
  const ownCommit: SharedUnlockCommit = { session: newSession, authorizationId: "88888888-8888-4888-8888-888888888888", authorizationSequence: 5, context };
  const participant = source.bind(context);
  cancels.push(() => { source.dispose(); participant.dispose(); masterKey.fill(0); member.privateKey.fill(0); });
  const ack = vi.fn();
  const envelope = vi.fn(async () => { events.push("envelope"); return participant.seal(masterKey, receiver.publicKey); });
  const input = { operation, verifiedSourcePublicKey: source.publicKey, envelope, acknowledge: ack };
  return { receiver, route, routeAbort, environment, manager, store, storage, hooks, masterKey, member,
    input, operation, ownCommit, fetcher, ack, envelope, events, api,
    invalidate: () => { current = false; }, pendingResponse };
}

describe("Extension own receiver transaction with real crypto and session installation", () => {
  it("publishes verified inherited authority independently of subsequent peer loss", async () => {
    const adopted = vi.fn<SharedUnlockInstalled>();
    const f = await setup({ onInstalled: adopted });
    await f.receiver.receive(f.input);
    expect(adopted).toHaveBeenCalledOnce();
    const [root, generation, ownCurrent] = adopted.mock.calls[0];
    expect(root).toMatchObject({ authorizationId: f.ownCommit.authorizationId, sequence: f.ownCommit.authorizationSequence,
      accountId: f.operation.context.accountId, organizationId: f.operation.context.organizationId,
      credentialRevision: f.operation.keyContext.credentialRevision, privateKeyWrapRevision: f.operation.keyContext.privateKeyWrapRevision,
      unlockedAtMs: f.operation.context.unlockedAtMs, absoluteDeadlineMs: f.operation.context.absoluteDeadlineMs,
      offlineDeadlineMs: f.operation.context.offlineDeadlineMs });
    expect(generation).toBe(f.route.binding.extensionGeneration);
    f.routeAbort.abort();
    expect(() => ownCurrent()).not.toThrow();
    await f.manager.lock();
    expect(() => ownCurrent()).toThrow();
  });

  it("installs the real receiver transaction from operation frames before sending its ACK", async () => {
    const f = await setup(); const envelope = await f.input.envelope();
    let receive!: (message: SharedUnlockOperationMessage) => void;
    const messages: SharedUnlockOperationMessage[] = [];
    let masterKeyAtAck: Uint8Array | null | undefined = null;
    const transport: SharedUnlockOperationTransport = {
      signal: new AbortController().signal, assertCurrent: f.route.assertCurrent, verifyCurrent: async () => f.route.assertCurrent(),
      onOperation: listener => { receive = listener; return () => {}; },
      sendOperation: raw => {
        const message = sharedUnlockOperationSchema.parse(raw); messages.push(message);
        if (message.payload.kind === "receiver-offer") receive(sharedUnlockOperationSchema.parse({ attemptId: message.attemptId,
          payload: { kind: "handoff", operation: f.operation, envelope } }));
        if (message.payload.kind === "ack") {
          masterKeyAtAck = f.manager.getKeys()?.masterKey;
        }
      },
    };
    const result = receiveSharedUnlockBrowserTransfer(transport, "A".repeat(43), async () => f.receiver);
    receive({ attemptId: "A".repeat(43), payload: { kind: "source-offer", publicKey: f.operation.sourcePublicKey } });
    expect((await result).operationId).toBe(f.operation.context.operationId);
    expect(masterKeyAtAck).toEqual(f.masterKey);
    expect(messages.map(m => m.payload.kind)).toEqual(["receiver-offer", "ack"]);
    expect(messages[1].payload).toEqual({ kind: "ack", operationId: f.operation.context.operationId,
      webGeneration: f.operation.context.webGeneration, extensionGeneration: f.operation.context.extensionGeneration });
    expect(JSON.stringify(messages)).not.toContain("receiver-own-");
  });

  it("verifies both proofs and recovers a Member key while installing only its own session before ACK", async () => {
    const f = await setup();
    const wrapped = await sealVaultKey(f.member.privateKey);
    const vaultKey = await unsealVaultKey(wrapped, f.member.privateKey);
    const sample = await encryptEntry({ type: ENTRY_TYPE_KEY, value: "synthetic-test-only" }, vaultKey);
    vaultKey.fill(0);
    const result = await f.receiver.receive(f.input);
    expect(f.events).toEqual(["consume", "envelope", "commit"]);
    expect(f.ack).toHaveBeenCalledExactlyOnceWith({ operationId: result.operationId,
      webGeneration: f.operation.context.webGeneration, extensionGeneration: f.operation.context.extensionGeneration });
    expect(Object.keys(result).sort()).toEqual(["authorizationId", "authorizationSequence", "operationId"]);
    expect(await f.manager.getStatus()).toBe("unlocked");
    expect(await f.manager.getAccessToken()).toBe(newSession.accessToken);
    expect(f.manager.getKeys()).toEqual({ masterKey: f.masterKey, privateKey: f.member.privateKey });
    expect(f.manager.getSharedUnlockLimits()).toEqual({ unlockedAtMs: f.operation.context.unlockedAtMs,
      idleDeadlineMs: f.operation.context.idleDeadlineMs, absoluteDeadlineMs: f.operation.context.absoluteDeadlineMs,
      offlineDeadlineMs: f.operation.context.offlineDeadlineMs });
    const recovered = await unsealVaultKey(wrapped, f.manager.getKeys()!.privateKey);
    expect(await decryptEntry(sample, recovered)).toEqual({ type: ENTRY_TYPE_KEY, value: "synthetic-test-only" });
    recovered.fill(0);
    const persisted = JSON.stringify(f.storage.values());
    for (const secret of [newSession.accessToken, newSession.refreshToken, toBase64Url(f.masterKey), toBase64Url(f.member.privateKey)]) expect(persisted).not.toContain(secret);
    f.receiver.cancel(); f.routeAbort.abort();
    expect(f.manager.getKeys()!.masterKey).toEqual(f.masterKey);
    expect(f.events).not.toContain("logout");
    await expect(f.receiver.receive(f.input)).rejects.toMatchObject({ code: "conflict" });
  });

  for (const key of ["accountId", "organizationId", "apiOrigin", "webOrigin", "extensionId", "documentBinding",
    "webGeneration", "extensionGeneration", "linkId", "linkEpoch", "preferenceRevision", "direction"] as const) {
    it(`rejects offered ${key} differing from independent route before sending a proof`, async () => {
      const f = await setup();
      const context = { ...f.operation.context, [key]: typeof f.operation.context[key] === "number" ? 999 : "other" };
      await expect(f.receiver.receive({ ...f.input, operation: { ...f.operation, context } })).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.manager.getKeys()).toBeNull();
    });
  }

  for (const change of ["lock", "logout", "environment", "route", "cancel", "abort", "new-attempt"] as const) {
    for (const pause of ["consume", "commit"] as const) {
      it(`rejects late ${pause} after ${change} and revokes only the incomplete issued lineage`, async () => {
        const f = await setup({ pause });
        const pending = f.receiver.receive(f.input);
        const rejection = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(f.events).toContain(pause));
        if (change === "lock") await f.manager.lock();
        if (change === "logout") await f.manager.logout();
        if (change === "environment") f.environment.value = "https://other.test";
        if (change === "route") f.invalidate();
        if (change === "cancel") f.receiver.cancel();
        if (change === "abort") f.routeAbort.abort();
        if (change === "new-attempt") await f.manager.beginSharedUnlockInstall(f.operation.context.accountId, apiUrl, () => {});
        f.pendingResponse.resolve(new Response(JSON.stringify(pause === "consume" ? f.operation : f.ownCommit)));
        await rejection;
        if (pause === "commit") await vi.waitFor(() => expect(f.events.filter(e => e === "logout")).toHaveLength(1));
        else expect(f.events).not.toContain("logout");
        expect(f.ack).not.toHaveBeenCalled();
        expect(f.manager.getKeys()).toBeNull();
        expect(await f.manager.getAccessToken()).toBeNull();
        expect(await f.store.getSealedSession()).toBeNull();
      });
    }
  }

  for (const field of ["sourcePublicKey", "recipientPublicKey", "recipientProofPublicKey"] as const) {
    it(`rejects a substituted ${field}`, async () => {
      const f = await setup();
      await expect(f.receiver.receive({ ...f.input, operation: { ...f.operation, [field]: toBase64Url(new Uint8Array(32)) } })).rejects.toThrow("participant binding");
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  }

  it("rejects a substituted consumed descriptor before commit", async () => {
    const f = await setup({ transformConsume: op => ({ ...op, keyContext: { ...op.keyContext, publicKey: toBase64Url(new Uint8Array(32)) } }) });
    await expect(f.receiver.receive(f.input)).rejects.toThrow("commitment");
    expect(f.events).not.toContain("commit");
    expect(f.manager.getKeys()).toBeNull();
  });

  it("rejects an envelope belonging to another document", async () => {
    const f = await setup();
    await expect(f.receiver.receive({ ...f.input, envelope: async () => {
      const sealed = await f.envelope();
      return { ...sealed, context: { ...sealed.context, documentBinding: "other" } };
    } })).rejects.toThrow();
    expect(f.events).not.toContain("commit");
  });

  it("revokes a minted session whose commit transcript changed", async () => {
    const f = await setup({ transformCommit: commit => ({ ...commit, context: { ...commit.context, linkEpoch: commit.context.linkEpoch + 1 } }) });
    await expect(f.receiver.receive(f.input)).rejects.toThrow("commit binding");
    expect(f.events.filter(e => e === "logout")).toHaveLength(1);
    expect(f.manager.getKeys()).toBeNull();
    expect(f.ack).not.toHaveBeenCalled();
  });

  for (const boundary of ["write", "unlocked-hook"] as const) {
    it(`rolls back its own envelope and revokes its token on peer loss during ${boundary}`, async () => {
      const f = await setup();
      if (boundary === "write") {
        const write = f.store.setSealedSession.bind(f.store);
        vi.spyOn(f.store, "setSealedSession").mockImplementationOnce(async value => { await write(value); f.routeAbort.abort(); });
      } else f.hooks.onUnlocked(() => f.routeAbort.abort());
      await expect(f.receiver.receive(f.input)).rejects.toThrow();
      expect(f.manager.getKeys()).toBeNull();
      expect(await f.store.getSealedSession()).toBeNull();
      expect(f.events.filter(e => e === "logout")).toHaveLength(1);
      expect(f.ack).not.toHaveBeenCalled();
    });
  }

  it("preserves successful installation if peer loss wins the installer promise continuation", async () => {
    const f = await setup();
    // Intercept this specific receiver's installer through the real manager at
    // the final route fence: queue peer loss after publication but before the
    // receiver's await continuation can run.
    let queued = false;
    const check = f.route.assertCurrent;
    f.route.assertCurrent = () => {
      check();
      if (!queued && f.manager.getKeys()) { queued = true; queueMicrotask(() => f.routeAbort.abort()); }
    };
    await f.receiver.receive(f.input);
    expect(f.routeAbort.signal.aborted).toBe(true);
    expect(await f.manager.getAccessToken()).toBe(newSession.accessToken);
    expect(f.manager.getKeys()!.masterKey).toEqual(f.masterKey);
    expect(f.events).not.toContain("logout");
  });

  it("keeps the own session after lost ACK without retry or cleanup logout", async () => {
    const f = await setup();
    const ack = vi.fn(() => { f.routeAbort.abort(); throw new Error("port lost"); });
    await f.receiver.receive({ ...f.input, acknowledge: ack });
    expect(ack).toHaveBeenCalledOnce();
    expect(f.manager.getKeys()!.masterKey).toEqual(f.masterKey);
    expect(f.events).not.toContain("logout");
    await expect(f.receiver.receive(f.input)).rejects.toMatchObject({ code: "conflict" });
    expect(ack).toHaveBeenCalledOnce();
  });

  it("cancels a stalled envelope without waiting for the transport", async () => {
    const f = await setup();
    const envelope = vi.fn(() => new Promise<unknown>(() => {}));
    const pending = f.receiver.receive({ ...f.input, envelope });
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(envelope).toHaveBeenCalledOnce());
    f.routeAbort.abort(); await rejection;
    expect(f.events).not.toContain("commit");
    expect(f.manager.getKeys()).toBeNull();
  });

  for (const action of ["lock", "logout", "new-attempt", "manual-unlock"] as const) {
    it(`immediately wipes recovered keys during stalled commit on ${action}, before a late response`, async () => {
      let recovered: SessionKeys | null = null;
      const recover = keyRecovery.recoverSharedUnlockKeys;
      vi.spyOn(keyRecovery, "recoverSharedUnlockKeys").mockImplementation(async (...args) => {
        recovered = await recover(...args); return recovered;
      });
      const f = await setup({ pause: "commit" });
      const pending = f.receiver.receive(f.input);
      const rejection = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(f.events).toContain("commit"));
      expect(recovered).not.toBeNull();
      const owned = recovered as unknown as SessionKeys;
      expect(owned.masterKey).toEqual(f.masterKey);
      if (action === "lock") await f.manager.lock();
      if (action === "logout") await f.manager.logout();
      if (action === "new-attempt") await f.manager.beginSharedUnlockInstall(f.operation.context.accountId, apiUrl, () => {});
      if (action === "manual-unlock") await f.manager.unlockWithPassword("synthetic-unusable").catch(() => {});
      await rejection;
      expect(owned.masterKey).toEqual(new Uint8Array(32));
      expect(owned.privateKey).toEqual(new Uint8Array(32));
      expect(f.events).not.toContain("logout");
      f.pendingResponse.resolve(new Response(JSON.stringify(f.ownCommit)));
      await vi.waitFor(() => expect(f.events.filter(e => e === "logout")).toHaveLength(1));
      expect(f.manager.getKeys()).toBeNull();
    });
  }

  it("disposes an unused receiver after thirty seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = await setup();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(f.receiver.receive(f.input)).rejects.toMatchObject({ code: "cancelled" });
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
