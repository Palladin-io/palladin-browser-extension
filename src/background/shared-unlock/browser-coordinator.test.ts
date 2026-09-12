import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSharedUnlockBrowserCoordinator, type SharedUnlockCoordinatorClient, type SharedUnlockCoordinatorRoute } from "./browser-coordinator";
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import type { SharedUnlockOperation } from "./api-types";
import type { SharedUnlockEnvelope } from "@palladin/crypto";
import fixtures from "./fixtures/session-api-v1.json";
import { SharedUnlockAuthorizationRetiredError } from "./expiry-store";
import { SharedUnlockPreferenceState } from "./preference-state";

const operation = fixtures.responses.find(r => r.type === "operation")!.body as SharedUnlockOperation;
const accountId = operation.context.accountId, organizationId = operation.context.organizationId, linkId = operation.context.linkId;
const settle = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
let counter = 0;
const nonce = async () => (++counter).toString(16).padStart(42, "0") + "A";
function endpoint(role: "web" | "extension", source: boolean) {
  const abort = new AbortController(), listeners = new Set<(message: SharedUnlockOperationMessage) => void>(), watchers = new Set<() => void>();
  let deliver: (message: SharedUnlockOperationMessage) => void = () => {};
  const messages: SharedUnlockOperationMessage[] = [];
  const route: SharedUnlockCoordinatorRoute = {
    signal: abort.signal, apiUrl: operation.context.apiOrigin, webOrigin: operation.context.webOrigin,
    extensionId: operation.context.extensionId, documentBinding: operation.context.documentBinding,
    assertCurrent: () => { if (abort.signal.aborted) throw new Error("closed"); },
    verifyCurrent: async () => { route.assertCurrent(); },
    close: () => abort.abort(),
    onOperation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sendOperation: message => { route.assertCurrent(); const parsed = sharedUnlockOperationSchema.parse(message); messages.push(parsed); queueMicrotask(() => deliver(parsed)); },
  };
  let state: Awaited<ReturnType<SharedUnlockCoordinatorClient["readState"]>> = {
    accountId: source ? accountId : null, status: source ? "unlocked" : "signed-out",
    source: source ? { organizationId, generation: role === "web" ? operation.context.webGeneration : operation.context.extensionGeneration } : null,
  };
  let installed = false;
  const client: SharedUnlockCoordinatorClient = {
    role, nonce, readState: vi.fn(async () => ({ ...state })), subscribe: listener => { watchers.add(listener); return () => { watchers.delete(listener); }; },
    selectLink: vi.fn(async (_accountId, proposed) => proposed ?? linkId),
    prepareSource: vi.fn(async () => ({ linkEpoch: operation.context.linkEpoch, preferenceRevision: operation.context.preferenceRevision })),
    checkReceiver: vi.fn(async () => {}),
    source: vi.fn(async (binding, _signal, check) => ({ publicKey: operation.sourcePublicKey, cancel: vi.fn(), send: async (input: Parameters<Awaited<ReturnType<SharedUnlockCoordinatorClient["source"]>>["send"]>[0]) => {
      await input.verifyRecipient(); check();
      const context = { ...operation.context, ...binding, direction: role === "web" ? "web-to-extension" as const : "extension-to-web" as const };
      const packet = { operation: { ...operation, context, sourcePublicKey: operation.sourcePublicKey,
        recipientPublicKey: input.recipientPublicKey, recipientProofPublicKey: input.recipientProofPublicKey },
      envelope: { protocol: "palladin.shared-unlock.v1", suite: "X25519-HKDF-SHA256-XCHACHA20POLY1305", context,
        sourcePublicKey: operation.sourcePublicKey, recipientPublicKey: input.recipientPublicKey, nonce: "A".repeat(32), ciphertext: "A".repeat(64) } as SharedUnlockEnvelope };
      input.send(packet);
      return { operationId: context.operationId, webGeneration: context.webGeneration, extensionGeneration: context.extensionGeneration };
    } })),
    receiver: vi.fn(async (binding, _signal, check) => ({ publicKey: operation.recipientPublicKey, proofPublicKey: operation.recipientProofPublicKey,
      cancel: vi.fn(), receive: async (input: Parameters<Awaited<ReturnType<SharedUnlockCoordinatorClient["receiver"]>>["receive"]>[0]) => {
        check(); expect(input.operation.context).toMatchObject(binding); await input.envelope(new AbortController().signal);
        installed = true;
        state = { accountId, status: "unlocked", source: { organizationId, generation: role === "web" ? binding.webGeneration : binding.extensionGeneration } };
        for (const watcher of watchers) watcher();
        try { input.acknowledge({ operationId: input.operation.context.operationId, webGeneration: binding.webGeneration, extensionGeneration: binding.extensionGeneration }); } catch { /* lost ACK */ }
        return { authorizationId: "local-only" };
      } })),
    received: vi.fn(),
  };
  return { client, route, messages, listeners, watchers, installed: () => installed,
    setState(next: typeof state) { state = next; for (const watcher of watchers) watcher(); },
    setDeliver(callback: typeof deliver) { deliver = callback; },
    emit(message: SharedUnlockOperationMessage) { for (const listener of [...listeners]) listener(message); } };
}
function pair(source: "web" | "extension") {
  const web = endpoint("web", source === "web"), extension = endpoint("extension", source === "extension");
  web.setDeliver(message => extension.emit(message)); extension.setDeliver(message => web.emit(message));
  return { web, extension, start() {
    const a = startSharedUnlockBrowserCoordinator(web.route, web.client), b = startSharedUnlockBrowserCoordinator(extension.route, extension.client);
    return Object.assign(() => { a.close(); b.close(); web.route.close(); extension.route.close(); },
      { web: a, extension: b });
  } };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); counter = 0; });
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe("automatic browser account/link selection", () => {
  it.each(["web", "extension"] as const)("bounds %s retirement retries across initial authenticated preference observation", async role => {
    const f = pair(role === "web" ? "extension" : "web"), recipient = f[role];
    const source = f[role === "web" ? "extension" : "web"];
    const normal = vi.mocked(recipient.client.receiver).getMockImplementation()!;
    vi.mocked(recipient.client.receiver).mockImplementation(async (...args) => ({
      ...await normal(...args), receive: async () => { throw new SharedUnlockAuthorizationRetiredError(); },
    }));
    const preferences = new SharedUnlockPreferenceState(), close = f.start();
    const scope = { apiUrl: operation.context.apiOrigin, accountId };
    const unwatch = preferences.subscribe(() => close[role].cancelPending(accountId));
    try {
      await settle(); expect(source.client.source).toHaveBeenCalledOnce();
      // Production refresh invalidates selection when its previously unknown
      // own preference is first observed. Repeated identical reads do not.
      preferences.observe(scope, { sharedUnlockEnabled: true, revision: operation.context.preferenceRevision });
      await settle(); expect(source.client.source).toHaveBeenCalledTimes(2);
      for (let index = 0; index < 10; index++) {
        preferences.observe(scope, { sharedUnlockEnabled: true, revision: operation.context.preferenceRevision });
        for (const changed of source.watchers) changed();
        await vi.advanceTimersByTimeAsync(5000); await settle();
      }
      expect(source.client.source).toHaveBeenCalledTimes(2);
      expect(recipient.client.received).not.toHaveBeenCalled();
      expect(recipient.route.signal.aborted).toBe(false);
    } finally { unwatch(); close(); }
  });
  it.each(["web", "extension"] as const)("still closes the channel for an unrelated %s receiver failure", async role => {
    const f = pair(role === "web" ? "extension" : "web"), recipient = f[role];
    const normal = vi.mocked(recipient.client.receiver).getMockImplementation()!;
    vi.mocked(recipient.client.receiver).mockImplementationOnce(async (...args) => ({
      ...await normal(...args), receive: async () => { throw new Error("cryptographic verification failed"); },
    }));
    const close = f.start();
    try {
      await settle();
      expect(recipient.route.signal.aborted).toBe(true);
      expect(recipient.installed()).toBe(false);
      expect(recipient.client.received).not.toHaveBeenCalled();
    } finally { close(); }
  });
  it.each(["web", "extension"] as const)("keeps the verified channel after %s denies a retired own authorization", async role => {
    const sourceRole = role === "web" ? "extension" : "web";
    const f = pair(sourceRole), source = f[sourceRole], recipient = f[role];
    const normal = vi.mocked(recipient.client.receiver).getMockImplementation()!;
    vi.mocked(recipient.client.receiver).mockImplementationOnce(async (...args) => ({
      ...await normal(...args), receive: async () => { throw new SharedUnlockAuthorizationRetiredError(); },
    }));
    const close = f.start();
    try {
      await settle();
      expect(recipient.route.signal.aborted).toBe(false);
      expect(source.route.signal.aborted).toBe(false);
      expect(recipient.installed()).toBe(false);
      expect(recipient.messages.filter(message => message.payload.kind === "cancel")).toHaveLength(1);
      // Ordinary own-activity notifications must not manufacture new attempts
      // after the receiver has definitively denied this own authorization.
      for (let index = 0; index < 10; index++) {
        for (const changed of source.watchers) changed();
        for (const changed of recipient.watchers) changed();
        await settle();
      }
      await vi.advanceTimersByTimeAsync(30_000); await settle();
      expect(source.client.source).toHaveBeenCalledOnce();
      expect(recipient.client.receiver).toHaveBeenCalledOnce();
      expect(recipient.client.received).not.toHaveBeenCalled();
      // A genuinely new manual source generation may make a fresh attempt.
      source.setState({ accountId, status: "unlocked", source: { organizationId, generation: await nonce() } });
      await settle();
      expect(recipient.installed()).toBe(true);
      expect(recipient.client.received).toHaveBeenCalledOnce();
      expect(source.client.source).toHaveBeenCalledTimes(2);
    } finally { close(); }
  });
  it.each(["web", "extension"] as const)("automatically runs %s source and selects all expected scope before crypto", async role => {
    const f = pair(role), close = f.start(); await settle();
    const source = f[role], recipient = f[role === "web" ? "extension" : "web"];
    expect(recipient.installed()).toBe(true); expect(recipient.client.received).toHaveBeenCalledOnce();
    expect(source.client.source).toHaveBeenCalledOnce(); expect(recipient.client.receiver).toHaveBeenCalledOnce();
    expect(recipient.client.receiver).toHaveBeenCalledWith(expect.objectContaining({ accountId, organizationId, linkId,
      apiOrigin: operation.context.apiOrigin, extensionId: operation.context.extensionId, documentBinding: operation.context.documentBinding }), expect.any(AbortSignal), expect.any(Function));
    expect(f.extension.client.selectLink).toHaveBeenCalledWith(accountId, undefined, role === "extension" ? "source" : "receiver");
    expect(f.web.client.selectLink).toHaveBeenCalledWith(accountId, linkId, role === "web" ? "source" : "receiver");
    expect(source.messages.map(m => m.payload.kind)).toContain("handoff");
    expect(JSON.stringify([...f.web.messages, ...f.extension.messages])).not.toContain("local-only");
    await settle(); expect(source.client.source).toHaveBeenCalledOnce(); // No reverse/recursive handoff.
    close(); expect(f.web.listeners.size + f.extension.listeners.size + f.web.watchers.size + f.extension.watchers.size).toBe(0);
  });
  it.each(["web", "extension"] as const)("does not switch another account to match %s source", async role => {
    const f = pair(role), recipient = f[role === "web" ? "extension" : "web"];
    recipient.setState({ status: "locked", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: null });
    const close = f.start(); await settle();
    expect(f.web.client.selectLink).not.toHaveBeenCalled(); expect(f.extension.client.selectLink).not.toHaveBeenCalled();
    expect(recipient.client.receiver).not.toHaveBeenCalled(); close();
  });
  it("waits for late manual source preparation without a new browser connection", async () => {
    const f = pair("web");
    f.web.setState({ accountId, status: "unlocked", source: null });
    const close = f.start(); await settle(); expect(f.extension.installed()).toBe(false);
    f.web.setState({ accountId, status: "unlocked", source: { organizationId, generation: operation.context.webGeneration } });
    await settle(); expect(f.extension.installed()).toBe(true); close();
  });
  it.each(["web", "extension"] as const)("renegotiates after own %s authority notification cancels pending preparation", async role => {
    const f = pair(role), source = f[role], recipient = f[role === "web" ? "extension" : "web"];
    let release!: () => void;
    let previousSignal!: AbortSignal;
    vi.mocked(source.client.prepareSource).mockImplementationOnce(async (_account, _organization, _link, signal) => {
      previousSignal = signal;
      await new Promise<void>(resolve => { release = resolve; });
      return { linkEpoch: operation.context.linkEpoch, preferenceRevision: operation.context.preferenceRevision };
    });
    const close = f.start();
    try {
      await settle(); expect(source.client.prepareSource).toHaveBeenCalledOnce();
      for (const changed of source.watchers) changed();
      expect(previousSignal.aborted).toBe(true);
      release(); await settle();
      expect(recipient.installed()).toBe(true);
      expect(source.client.prepareSource).toHaveBeenCalledTimes(2);
      expect(source.client.source).toHaveBeenCalledOnce();
      expect(recipient.client.received).toHaveBeenCalledOnce();
    } finally { close(); }
  });
  it.each(["web", "extension"] as const)("replaces an interrupted %s crypto offer with a fresh attempt", async role => {
    const f = pair(role), source = f[role], recipient = f[role === "web" ? "extension" : "web"];
    const original = source.client.source;
    let release!: () => void;
    let previousCheck!: () => void;
    vi.mocked(source.client.source).mockImplementationOnce(async (...args) => {
      previousCheck = args[2];
      await new Promise<void>(resolve => { release = resolve; });
      previousCheck(); return original(...args);
    });
    const close = f.start();
    try {
      await settle(); expect(source.client.source).toHaveBeenCalledOnce();
      const oldPrepare = source.messages.find(message => message.payload.kind === "prepare")!;
      for (const changed of source.watchers) changed();
      expect(previousCheck).toThrow();
      release(); await settle();
      expect(recipient.installed()).toBe(true);
      expect(recipient.client.received).toHaveBeenCalledOnce();
      const prepares = source.messages.filter(message => message.payload.kind === "prepare");
      expect(prepares).toHaveLength(2);
      expect(prepares[1]!.attemptId).not.toBe(oldPrepare.attemptId);
      expect(source.messages.filter(message => message.payload.kind === "handoff")).toHaveLength(1);
    } finally { close(); }
  });
  it.each([
    ["web", "locked"], ["extension", "locked"],
    ["web", "signed-out"], ["extension", "signed-out"],
    ["web", "unavailable"], ["extension", "unavailable"],
  ] as const)("does not revive %s source preparation after authority becomes %s", async (role, status) => {
    const f = pair(role), source = f[role], recipient = f[role === "web" ? "extension" : "web"];
    let release!: () => void;
    let previousSignal!: AbortSignal;
    vi.mocked(source.client.prepareSource).mockImplementationOnce(async (_account, _organization, _link, signal) => {
      previousSignal = signal;
      await new Promise<void>(resolve => { release = resolve; });
      return { linkEpoch: operation.context.linkEpoch, preferenceRevision: operation.context.preferenceRevision };
    });
    const close = f.start();
    try {
      await settle();
      source.setState({ accountId: status === "signed-out" ? null : accountId,
        status: status === "unavailable" ? "unlocked" : status, source: null });
      expect(previousSignal.aborted).toBe(true);
      release(); await settle();
      expect(recipient.installed()).toBe(false);
      expect(source.client.source).not.toHaveBeenCalled();
      expect(source.client.prepareSource).toHaveBeenCalledOnce();
      expect(recipient.client.received).not.toHaveBeenCalled();
    } finally { close(); }
  });
  it("does not start crypto while Web is still persisting its selected link", async () => {
    const f = pair("extension"); let resolve!: (id: string) => void;
    vi.mocked(f.web.client.selectLink).mockImplementation(() => new Promise(r => { resolve = r; }));
    const close = f.start(); await settle(); expect(f.extension.client.prepareSource).not.toHaveBeenCalled();
    resolve(linkId); await settle(); expect(f.web.installed()).toBe(true); close();
  });
  it("a saved local disconnect prevents source preparation and receiver crypto", async () => {
    const f = pair("web"); vi.mocked(f.extension.client.selectLink).mockRejectedValue(new Error("disconnected"));
    const close = f.start(); await settle(); expect(f.web.client.prepareSource).not.toHaveBeenCalled();
    expect(f.extension.client.receiver).not.toHaveBeenCalled(); close();
  });
  it("bounds a stopped receiver storage check and never starts a late crypto receiver", async () => {
    const f = pair("web"); let resolve!: () => void;
    vi.mocked(f.extension.client.checkReceiver).mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const close = f.start(); await settle(); expect(f.extension.client.checkReceiver).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); await settle();
    expect(f.extension.client.receiver).not.toHaveBeenCalled();
    resolve(); await settle(); expect(f.extension.client.receiver).not.toHaveBeenCalled(); close();
  });
  it.each(["web", "extension"] as const)("explicit pause cancels an active %s receiver and resume uses a fresh attempt", async role => {
    const sourceRole = role === "web" ? "extension" : "web";
    const f = pair(sourceRole), receiver = f[role];
    const original = receiver.client.receiver;
    let release!: () => void;
    let oldSignal!: AbortSignal;
    let oldCheck!: () => void;
    vi.mocked(receiver.client.receiver).mockImplementationOnce(async (...args) => {
      oldSignal = args[1]; oldCheck = args[2];
      await new Promise<void>(resolve => { release = resolve; });
      oldCheck(); return original(...args);
    });
    const close = f.start(); await settle();
    expect(receiver.client.receiver).toHaveBeenCalledOnce();
    const oldPrepare = f[sourceRole].messages.find(m => m.payload.kind === "prepare")!;
    close[role].cancelPending("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(oldSignal.aborted).toBe(false);
    vi.mocked(receiver.client.selectLink).mockRejectedValue(new Error("locally paused"));
    close[role].cancelPending(accountId);
    expect(oldSignal.aborted).toBe(true);
    expect(oldCheck).toThrow();
    release(); await settle();
    expect(receiver.installed()).toBe(false);
    expect(receiver.route.signal.aborted).toBe(false);
    expect(receiver.client.received).not.toHaveBeenCalled();
    vi.mocked(receiver.client.selectLink).mockImplementation(async (_account, proposed) => proposed ?? linkId);
    close[role].cancelPending(accountId); await settle();
    expect(receiver.installed()).toBe(true);
    const prepares = f[sourceRole].messages.filter(m => m.payload.kind === "prepare");
    expect(prepares.at(-1)!.attemptId).not.toBe(oldPrepare.attemptId);
    close();
  });
  it("rejects a substituted organization in preparation before receiver crypto", async () => {
    const f = pair("web");
    f.web.setDeliver(message => f.extension.emit(message.payload.kind === "prepare"
      ? { ...message, payload: { ...message.payload, organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } : message));
    const close = f.start(); await settle();
    expect(f.extension.client.receiver).not.toHaveBeenCalled(); expect(f.extension.route.signal.aborted).toBe(true); close();
  });

});
