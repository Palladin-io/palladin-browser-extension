import { sendSharedUnlockBrowserTransfer, type SharedUnlockOperationTransport } from "./browser-transfer";
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedUnlockOffer, createSharedUnlockIdentityProofSigner, randomBytes, generateKeyPair, encryptWithKey,
  hashSharedUnlockKeyContext, hashSharedUnlockTranscript, loadSodium, toBase64Url, sealVaultKey, unsealVaultKey,
  type SharedUnlockEnvelope, encryptEntry, decryptEntry, ENTRY_TYPE_KEY } from "@palladin/crypto";
import { AuthClient } from "../session/auth-client";
import { AutoLock } from "../session/auto-lock";
import { SessionManager } from "../session/session-manager";
import { SessionStore } from "../session/session-store";
import { FakeAlarms, FakeStorageArea } from "../session/test-support";
import { SharedUnlockApi } from "./api";
import { SharedUnlockSourceAuthority, type SharedUnlockSourceState } from "./source-authority";
import { beginSharedUnlockSource, type SharedUnlockSourceRoute } from "./source";
import { recoverSharedUnlockKeys } from "../../shared/crypto/shared-unlock-keys";
import type { SharedUnlockOperation, SharedUnlockOperationInput } from "./api-types";
import fixtures from "./fixtures/session-api-v1.json";

const apiUrl = "https://api.example.test";
const baseline = fixtures.responses.find(r => r.type === "operation" && r.body.context?.direction === "extension-to-web")!.body as SharedUnlockOperation;
const now = baseline.context.issuedAtMs;
const cleanups: (() => void)[] = [];
beforeAll(async () => { await loadSodium(); });
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

async function setup(options: { pause?: boolean; verifyRecipient?: () => Promise<void>;
  transform?: (operation: SharedUnlockOperation) => SharedUnlockOperation | Promise<SharedUnlockOperation> } = {}) {
  const original = baseline.context;
  const masterKey = await randomBytes(32);
  const member = await generateKeyPair();
  const holder: { state: SharedUnlockSourceState } = { state: {
    preference: { sharedUnlockEnabled: true, revision: original.preferenceRevision }, sourceGeneration: original.extensionGeneration, failure: null,
    authorization: { authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 5,
      accountId: original.accountId, organizationId: original.organizationId,
      credentialRevision: baseline.keyContext.credentialRevision, privateKeyWrapRevision: baseline.keyContext.privateKeyWrapRevision,
      authorizationVersion: original.authorizationVersion, unlockedAtMs: original.unlockedAtMs, idleDeadlineMs: original.idleDeadlineMs,
      absoluteDeadlineMs: original.absoluteDeadlineMs, offlineDeadlineMs: original.offlineDeadlineMs } } };
  const routeAbort = new AbortController();
  const environment = { value: apiUrl };
  const route: SharedUnlockSourceRoute = { apiUrl, signal: routeAbort.signal, binding: {
    accountId: original.accountId, organizationId: original.organizationId, apiOrigin: apiUrl,
    webOrigin: original.webOrigin, extensionId: original.extensionId, documentBinding: original.documentBinding,
    webGeneration: original.webGeneration, extensionGeneration: original.extensionGeneration,
    linkId: original.linkId, linkEpoch: original.linkEpoch, preferenceRevision: original.preferenceRevision,
  }, assertCurrent: () => { if (routeAbort.signal.aborted) throw new Error("retired"); } };
  const recipient = await createSharedUnlockOffer({ role: "recipient", assertCurrent: () => {} });
  const signer = await createSharedUnlockIdentityProofSigner({ assertCurrent: () => {} });
  const keyContext = { ...baseline.keyContext, publicKey: toBase64Url(member.publicKey), encryptedPrivateKey: toBase64Url(await encryptWithKey(member.privateKey, masterKey)) };
  const pending = deferred<Response>();
  let operation: SharedUnlockOperation | null = null;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/api/auth/logout")) return new Response(null, { status: 204 });
    if (String(url).endsWith("/api/auth/refresh")) return new Response(JSON.stringify({ accessToken: "rotated-own-access", refreshToken: "rotated-own-refresh" }));
    expect(url).toBe(apiUrl + "/api/account/shared-unlock/operations");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer own-source-access");
    const input = JSON.parse(String(init?.body)) as SharedUnlockOperationInput & { refreshToken: string };
    expect(input.refreshToken).toBe("own-source-refresh");
    expect(input.authorizationId).toBe(holder.state.authorization?.authorizationId);
    expect(input.direction).toBe("extension-to-web");
    const context = { ...original, ...route.binding, keyContextDigest: await hashSharedUnlockKeyContext(keyContext),
      idleDeadlineMs: input.idleDeadlineMs, absoluteDeadlineMs: input.absoluteDeadlineMs, offlineDeadlineMs: input.offlineDeadlineMs };
    const created: SharedUnlockOperation = { ...baseline, context, keyContext, sourcePublicKey: input.sourcePublicKey,
      recipientPublicKey: input.recipientPublicKey, recipientProofPublicKey: input.recipientProofPublicKey,
      transcriptHash: await hashSharedUnlockTranscript(context, input.sourcePublicKey, input.recipientPublicKey) };
    operation = options.transform ? await options.transform(created) : created;
    return options.pause ? pending.promise : new Response(JSON.stringify(operation));
  });
  const storage = new FakeStorageArea(); const store = new SessionStore(storage);
  let manager: SessionManager;
  manager = new SessionManager({ store, authClient: new AuthClient(fetcher, () => environment.value),
    autoLock: new AutoLock(new FakeAlarms(), () => { void manager.lock(); }) });
  // Establish a real own session independently of the source operation. The
  // authority snapshot stands in for already-tested Identity manual preparation.
  await (await manager.beginSharedUnlockInstall(original.accountId, apiUrl, () => {})).install({
    keys: { masterKey, privateKey: member.privateKey },
    tokens: { apiUrl, userId: original.accountId, accessToken: "own-source-access", refreshToken: "own-source-refresh" },
    material: { accountId: keyContext.accountId, encryptedPrivateKey: keyContext.encryptedPrivateKey,
      kdf: { securityVersion: keyContext.securityVersion, minimumSecurityVersion: keyContext.minimumSecurityVersion,
        profileId: keyContext.kdfProfileId, kdfSalt: keyContext.kdfSalt } },
    limits: { unlockedAtMs: original.unlockedAtMs, idleDeadlineMs: original.idleDeadlineMs,
      absoluteDeadlineMs: original.absoluteDeadlineMs, offlineDeadlineMs: original.offlineDeadlineMs },
  });
  const api = new SharedUnlockApi(fetcher, () => environment.value);
  const authority = new SharedUnlockSourceAuthority(api);
  vi.spyOn(authority, "snapshot").mockImplementation(() => ({ ...holder.state,
    authorization: holder.state.authorization ? { ...holder.state.authorization } : null,
    preference: holder.state.preference ? { ...holder.state.preference } : null }));
  const source = await beginSharedUnlockSource(route, manager, authority, api);
  cleanups.push(source.cancel, () => { void manager.lock(); recipient.dispose(); signer.dispose(); masterKey.fill(0); member.privateKey.fill(0); });
  const input = { recipientPublicKey: recipient.publicKey, recipientProofPublicKey: signer.publicKey };
  const delivered = vi.fn<(packet: { operation: SharedUnlockOperation; envelope: SharedUnlockEnvelope }) => void>();
  const verifyRecipient = vi.fn(options.verifyRecipient ?? (async () => { route.assertCurrent(); }));
  const run = async () => {
    await source.send({ ...input, verifyRecipient, send: delivered });
    return delivered.mock.lastCall![0];
  };
  return { source, route, recipient, signer, masterKey, member, fetcher, pending, operation: () => operation,
    input, routeAbort, run, delivered, verifyRecipient, manager, store, storage, holder, environment, authority, api };
}

describe("Extension source transaction with real SDK and own SessionManager", () => {
  it("delivers the real source transaction through operation frames and decrypts its envelope", async () => {
    const f = await setup();
    let receive!: (message: SharedUnlockOperationMessage) => void;
    let recovered: Promise<void> | null = null;
    const messages: SharedUnlockOperationMessage[] = [];
    const transport: SharedUnlockOperationTransport = {
      signal: f.routeAbort.signal, assertCurrent: f.route.assertCurrent, verifyCurrent: async () => f.route.assertCurrent(),
      onOperation: listener => { receive = listener; return () => {}; },
      sendOperation: raw => {
        const message = sharedUnlockOperationSchema.parse(raw); messages.push(message);
        if (message.payload.kind === "source-offer") receive({ attemptId: message.attemptId,
          payload: { kind: "receiver-offer", publicKey: f.input.recipientPublicKey, proofPublicKey: f.input.recipientProofPublicKey } });
        if (message.payload.kind === "handoff") {
          const { operation, envelope } = message.payload;
          recovered = (async () => {
            const participant = f.recipient.bind(operation.context);
            try {
              const mk = await participant.open(envelope, f.source.publicKey);
              try { expect(mk).toEqual(f.masterKey); } finally { mk.fill(0); }
            } finally { participant.dispose(); }
            receive({ attemptId: message.attemptId, payload: { kind: "ack", operationId: operation.context.operationId,
              webGeneration: operation.context.webGeneration, extensionGeneration: operation.context.extensionGeneration } });
          })();
          void recovered.catch(() => f.routeAbort.abort());
        }
      },
    };
    const result = await sendSharedUnlockBrowserTransfer(transport, "A".repeat(43), async () => f.source);
    await recovered;
    expect(result.acknowledged).toBe(true); expect(messages.map(m => m.payload.kind)).toEqual(["source-offer", "handoff"]);
    expect(JSON.stringify(messages)).not.toContain("own-source-");
  });

  it("sends one bound envelope that recovers Member/Entry keys without modifying the own session or limits", async () => {
    const f = await setup(); const before = f.manager.getKeys(); const limits = f.manager.getSharedUnlockLimits();
    const persisted = f.storage.values();
    const result = await f.run();
    expect(Object.keys(result).sort()).toEqual(["envelope", "operation"]);
    expect(JSON.stringify(result)).not.toContain("own-source-");
    expect(JSON.parse(String(f.fetcher.mock.lastCall![1]!.body))).toMatchObject({
      idleDeadlineMs: limits!.idleDeadlineMs, absoluteDeadlineMs: limits!.absoluteDeadlineMs, offlineDeadlineMs: limits!.offlineDeadlineMs });
    const receiver = f.recipient.bind(result.operation.context);
    const mk = await receiver.open(result.envelope, f.source.publicKey);
    const keys = await recoverSharedUnlockKeys(mk, result.operation.keyContext, result.operation.context.accountId,
      result.operation.context.keyContextDigest, () => {});
    const wrapped = await sealVaultKey(f.member.privateKey); const vk = await unsealVaultKey(wrapped, f.member.privateKey);
    const entry = await encryptEntry({ type: ENTRY_TYPE_KEY, value: "synthetic-source-test" }, vk); vk.fill(0);
    const receivedVk = await unsealVaultKey(wrapped, keys.privateKey);
    expect(await decryptEntry(entry, receivedVk)).toEqual({ type: ENTRY_TYPE_KEY, value: "synthetic-source-test" });
    receivedVk.fill(0); keys.masterKey.fill(0); keys.privateKey.fill(0); receiver.dispose();
    expect(f.manager.getKeys()).toBe(before); expect(f.manager.getSharedUnlockLimits()).toEqual(limits);
    expect(f.storage.values()).toEqual(persisted);
    f.routeAbort.abort(); f.source.cancel();
    expect(await f.manager.getAccessToken()).toBe("own-source-access");
    await expect(f.run()).rejects.toMatchObject({ code: "conflict" });
    expect(f.manager.getKeys()).toBe(before);
  });

  for (const field of ["accountId", "organizationId", "apiOrigin", "webOrigin", "extensionId", "documentBinding",
    "webGeneration", "extensionGeneration", "linkId", "linkEpoch", "preferenceRevision", "authorizationVersion", "direction"] as const) {
    it(`rejects substituted Identity crypto scope ${field}`, async () => {
      const f = await setup({ transform: op => ({ ...op, context: { ...op.context,
        [field]: typeof op.context[field] === "number" ? 999 : "other" } }) });
      await expect(f.run()).rejects.toThrow(); expect(f.delivered).not.toHaveBeenCalled();
      expect(f.manager.getKeys()).not.toBeNull();
    });
  }
  for (const field of ["sourcePublicKey", "recipientPublicKey", "recipientProofPublicKey", "transcriptHash"] as const) {
    it(`rejects substituted ${field}`, async () => {
      const f = await setup({ transform: op => ({ ...op, [field]: toBase64Url(new Uint8Array(32)) }) });
      await expect(f.run()).rejects.toThrow(); expect(f.delivered).not.toHaveBeenCalled();
    });
  }
  it("rejects a self-consistent substituted member descriptor against the own private key", async () => {
    const other = await generateKeyPair();
    const f = await setup({ transform: async op => {
      const keyContext = { ...op.keyContext, publicKey: toBase64Url(other.publicKey),
        encryptedPrivateKey: toBase64Url(await encryptWithKey(other.privateKey, f.masterKey)) };
      const context = { ...op.context, keyContextDigest: await hashSharedUnlockKeyContext(keyContext) };
      return { ...op, context, keyContext, transcriptHash: await hashSharedUnlockTranscript(context, op.sourcePublicKey, op.recipientPublicKey) };
    } });
    try { await expect(f.run()).rejects.toThrow("own member key differs"); }
    finally { other.privateKey.fill(0); }
    expect(f.manager.getKeys()).not.toBeNull();
  });
  it("rejects a descriptor with a different commitment", async () => {
    const f = await setup({ transform: op => ({ ...op, keyContext: { ...op.keyContext, publicKey: toBase64Url(new Uint8Array(32)) } }) });
    await expect(f.run()).rejects.toThrow("commitment");
  });

  for (const action of ["lock", "logout", "manual", "refresh", "route", "environment", "off", "revision", "root", "cancel", "expiry"] as const) {
    it(`does not send after ${action} during a pending operation`, async () => {
      const f = await setup({ pause: true }); const pending = f.run(); const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(f.operation()).not.toBeNull());
      if (action === "lock") await f.manager.lock();
      if (action === "logout") await f.manager.logout();
      if (action === "manual") await f.manager.unlockWithPassword("synthetic-wrong").catch(() => {});
      if (action === "refresh") await f.manager.refreshAccessToken();
      if (action === "route") f.routeAbort.abort();
      if (action === "environment") f.environment.value = "https://other.test";
      if (action === "off") f.holder.state = { ...f.holder.state, preference: { ...f.holder.state.preference!, sharedUnlockEnabled: false } };
      if (action === "revision") f.holder.state = { ...f.holder.state, preference: { ...f.holder.state.preference!, revision: 999 } };
      if (action === "root") f.holder.state = { ...f.holder.state, authorization: null };
      if (action === "cancel") f.source.cancel();
      if (action === "expiry") vi.mocked(Date.now).mockReturnValue(now + 31_000);
      if (["lock", "logout", "manual", "refresh", "route", "cancel"].includes(action)) await rejected;
      f.pending.resolve(new Response(JSON.stringify(f.operation())));
      await rejected;
      expect(f.delivered).not.toHaveBeenCalled();
      if (action === "refresh") expect(await f.manager.getAccessToken()).toBe("rotated-own-access");
    });
  }

  for (const field of ["accountId", "organizationId", "authorizationVersion", "credentialRevision", "privateKeyWrapRevision"] as const) {
    it(`checks current own root ${field} before operation creation`, async () => {
      const f = await setup();
      const root = f.holder.state.authorization!;
      f.holder.state = { ...f.holder.state, authorization: { ...root, [field]: typeof root[field] === "number" ? 999 : "other" } };
      await expect(f.run()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    });
  }
  for (const action of ["lock", "route", "root", "refresh"] as const) {
    it(`retains authority through final async browser verification against ${action}`, async () => {
      const verifying = deferred<void>();
      const f = await setup({ verifyRecipient: () => verifying.promise });
      const pending = f.run(); const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(f.verifyRecipient).toHaveBeenCalledOnce());
      if (action === "lock") await f.manager.lock();
      if (action === "route") f.routeAbort.abort();
      if (action === "root") f.holder.state = { ...f.holder.state, authorization: null };
      if (action === "refresh") await f.manager.refreshAccessToken();
      verifying.resolve(); await rejected; expect(f.delivered).not.toHaveBeenCalled();
    });
  }
  it("does not retry an accepted browser send that throws", async () => {
    const f = await setup(); const send = vi.fn(() => { throw new Error("port lost after accepting"); });
    await expect(f.source.send({ ...f.input, verifyRecipient: async () => {}, send })).rejects.toThrow();
    await expect(f.source.send({ ...f.input, verifyRecipient: async () => {}, send })).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledOnce(); expect(f.manager.getKeys()).not.toBeNull();
  });
  it("projects unknown Identity additions out of every outgoing browser layer", async () => {
    const f = await setup({ transform: op => ({ ...op, extra: "private-future-data", context: { ...op.context, extra: "private-future-data" },
      keyContext: { ...op.keyContext, extra: "private-future-data" } }) });
    const result = await f.run(); expect(JSON.stringify(result)).not.toContain("private-future-data");
  });
  it("retires an unused offer after thirty seconds without modifying the own session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await setup(); await vi.advanceTimersByTimeAsync(30_000);
    await expect(f.run()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.manager.getKeys()).not.toBeNull();
  });
});
