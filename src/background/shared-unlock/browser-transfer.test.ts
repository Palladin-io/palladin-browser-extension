import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveSharedUnlockBrowserTransfer, sendSharedUnlockBrowserTransfer, type SharedUnlockOperationTransport } from "./browser-transfer";
import { sharedUnlockOperationSchema, type SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import type { SharedUnlockOperation } from "./api-types";
import type { SharedUnlockEnvelope } from "@palladin/crypto";
import fixtures from "./fixtures/session-api-v1.json";

const attemptId = "A".repeat(43);
const operation = fixtures.responses.find(r => r.type === "operation")!.body as SharedUnlockOperation;
const ack = { operationId: operation.context.operationId, webGeneration: operation.context.webGeneration,
  extensionGeneration: operation.context.extensionGeneration };
const packet = { operation, envelope: { protocol: "palladin.shared-unlock.v1", suite: "X25519-HKDF-SHA256-XCHACHA20POLY1305",
  context: operation.context, sourcePublicKey: operation.sourcePublicKey, recipientPublicKey: operation.recipientPublicKey,
  nonce: "A".repeat(32), ciphertext: "A".repeat(64) } as SharedUnlockEnvelope };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function channel() {
  const abort = new AbortController();
  const listeners = new Set<(message: SharedUnlockOperationMessage) => void>();
  const sent: SharedUnlockOperationMessage[] = [];
  const transport: SharedUnlockOperationTransport = {
    signal: abort.signal,
    assertCurrent: vi.fn(() => { if (abort.signal.aborted) throw new Error("retired"); }),
    verifyCurrent: vi.fn(async () => { transport.assertCurrent(); }),
    onOperation: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    sendOperation: vi.fn(message => { transport.assertCurrent(); sent.push(sharedUnlockOperationSchema.parse(message)); }),
  };
  const emit = (payload: SharedUnlockOperationMessage["payload"], id = attemptId) => {
    const message = sharedUnlockOperationSchema.parse({ attemptId: id, payload });
    for (const listener of [...listeners]) listener(message);
  };
  return { transport, abort, listeners, sent, emit };
}
function source() {
  return { publicKey: operation.sourcePublicKey, cancel: vi.fn(),
    send: vi.fn(async (input: { verifyRecipient(): Promise<void>; send(packet: { operation: SharedUnlockOperation; envelope: SharedUnlockEnvelope }): void }) => {
      await input.verifyRecipient(); input.send(packet); return ack;
    }) };
}
function receiver() {
  let installed = false;
  return { publicKey: operation.recipientPublicKey, proofPublicKey: operation.recipientProofPublicKey,
    cancel: vi.fn(() => { /* The real transaction preserves a completed own session. */ }),
    installed: () => installed,
    receive: vi.fn(async (input: { operation: SharedUnlockOperation; verifiedSourcePublicKey: string;
      envelope(signal: AbortSignal): Promise<unknown>; acknowledge(result: typeof ack): void }) => {
      expect(input.operation).toEqual(operation); expect(input.verifiedSourcePublicKey).toBe(operation.sourcePublicKey);
      expect(await input.envelope(new AbortController().signal)).toEqual(packet.envelope);
      installed = true;
      try { input.acknowledge(ack); } catch { /* Mirrors the transaction's best-effort ACK boundary. */ }
      return "own-session";
    }) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("browser transfer orchestration (transport/transaction seams)", () => {
  it.each([
    { kind: "source-offer", publicKey: "A".repeat(42) + "B" },
    { kind: "receiver-offer", publicKey: "A".repeat(43), proofPublicKey: "A".repeat(43), accessToken: "synthetic" },
    { kind: "ack", ...ack, authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { kind: "handoff", ...packet, operation: { ...operation, context: { ...operation.context, refreshToken: "synthetic" } } },
    { kind: "handoff", ...packet, operation: { ...operation, keyContext: { ...operation.keyContext, privateKey: "synthetic" } } },
    { kind: "handoff", ...packet, envelope: { ...packet.envelope, ciphertext: "A".repeat(65) } },
    { kind: "handoff", ...packet, operation: { ...operation, keyContext: { ...operation.keyContext, encryptedPrivateKey: "A".repeat(5463) } } },
  ])("rejects malformed or expanded independent browser payload %#", payload => {
    expect(sharedUnlockOperationSchema.safeParse({ attemptId, payload }).success).toBe(false);
  });

  it("exchanges bounded offers, handoff and exact ACK through both coordinators", async () => {
    const left = channel(), right = channel(), s = source(), r = receiver();
    vi.mocked(left.transport.sendOperation).mockImplementation(message => { left.sent.push(sharedUnlockOperationSchema.parse(message)); right.emit(message.payload, message.attemptId); });
    vi.mocked(right.transport.sendOperation).mockImplementation(message => { right.sent.push(sharedUnlockOperationSchema.parse(message)); left.emit(message.payload, message.attemptId); });
    const receive = receiveSharedUnlockBrowserTransfer(right.transport, attemptId, async () => r);
    const send = sendSharedUnlockBrowserTransfer(left.transport, attemptId, async () => s);
    expect(await receive).toBe("own-session"); expect(await send).toEqual({ ...ack, acknowledged: true });
    expect(left.sent.map(m => m.payload.kind)).toEqual(["source-offer", "handoff"]);
    expect(right.sent.map(m => m.payload.kind)).toEqual(["receiver-offer", "ack"]);
    expect(right.sent[1]).toEqual({ attemptId, payload: { kind: "ack", ...ack } });
    expect(left.listeners.size + right.listeners.size).toBe(0);
  });
  it("ignores an old attempt and refuses a reordered handoff without starting receiver crypto", async () => {
    const f = channel(), create = vi.fn(async () => receiver());
    const task = receiveSharedUnlockBrowserTransfer(f.transport, attemptId, create); const rejected = expect(task).rejects.toThrow();
    f.emit({ kind: "source-offer", publicKey: operation.sourcePublicKey }, "E".repeat(43));
    await settle(); expect(create).not.toHaveBeenCalled();
    f.emit({ kind: "handoff", ...packet }); await rejected; expect(create).not.toHaveBeenCalled();
  });
  it.each(["source", "receiver"])("disposes a late %s factory after route loss", async role => {
    const f = channel(), s = source(), r = receiver();
    const pending = deferred<typeof s & typeof r>();
    const create = vi.fn(() => pending.promise);
    const task = role === "source" ? sendSharedUnlockBrowserTransfer(f.transport, attemptId, create)
      : receiveSharedUnlockBrowserTransfer(f.transport, attemptId, create);
    const rejected = expect(task).rejects.toThrow();
    if (role === "receiver") f.emit({ kind: "source-offer", publicKey: operation.sourcePublicKey });
    await settle(); expect(create).toHaveBeenCalledOnce(); f.abort.abort(); await rejected;
    const handle = { ...s, ...r }; pending.resolve(handle); await settle();
    expect(handle.cancel).toHaveBeenCalledOnce(); expect(f.sent).toEqual([]); expect(f.listeners.size).toBe(0);
  });
  it.each(["source", "receiver"])("cleans the %s deadline if subscription fails", async role => {
    const f = channel(); vi.mocked(f.transport.onOperation).mockImplementation(() => { throw new Error("subscription retired"); });
    const task = role === "source" ? sendSharedUnlockBrowserTransfer(f.transport, attemptId, async () => source())
      : receiveSharedUnlockBrowserTransfer(f.transport, attemptId, async () => receiver());
    await expect(task).rejects.toThrow("subscription retired");
  });
  it("checks wall-clock expiry even when the deadline timer has not fired", async () => {
    const f = channel(), s = source();
    const task = sendSharedUnlockBrowserTransfer(f.transport, attemptId, async () => s); const rejected = expect(task).rejects.toThrow();
    await settle(); vi.setSystemTime(Date.now() + 30_000);
    f.emit({ kind: "receiver-offer", publicKey: operation.recipientPublicKey, proofPublicKey: operation.recipientProofPublicKey });
    await rejected; expect(s.send).not.toHaveBeenCalled();
  });
  it.each(["peer", "timeout", "wrong-ack"])("returns unconfirmed delivery after %s without resending a handoff", async reason => {
    const f = channel(), s = source(); const task = sendSharedUnlockBrowserTransfer(f.transport, attemptId, async () => s);
    await settle(); f.emit({ kind: "receiver-offer", publicKey: operation.recipientPublicKey, proofPublicKey: operation.recipientProofPublicKey }); await settle();
    if (reason === "peer") f.abort.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    if (reason === "wrong-ack") f.emit({ kind: "ack", ...ack, operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(await task).toEqual({ ...ack, acknowledged: false }); expect(s.send).toHaveBeenCalledOnce();
    expect(f.sent.filter(m => m.payload.kind === "handoff")).toHaveLength(1);
  });
  it("waits for installer rollback after cancellation instead of abandoning local storage work", async () => {
    const f = channel(), r = receiver(), rollback = deferred<never>();
    r.receive.mockImplementation(() => rollback.promise);
    const task = receiveSharedUnlockBrowserTransfer(f.transport, attemptId, async () => r);
    let ended = false; void task.then(() => { ended = true; }, () => { ended = true; });
    f.emit({ kind: "source-offer", publicKey: operation.sourcePublicKey }); await settle();
    f.emit({ kind: "handoff", ...packet }); await settle(); expect(r.receive).toHaveBeenCalledOnce();
    f.abort.abort(); await settle(); expect(r.cancel).toHaveBeenCalledOnce(); expect(ended).toBe(false);
    // A completed rollback may resolve or reject; the coordinator must await it.
    rollback.resolve(undefined as never); await task; expect(ended).toBe(true);
  });
  it("keeps successful receiver completion when the native Port disappears during ACK", async () => {
    const f = channel(), r = receiver();
    vi.mocked(f.transport.sendOperation).mockImplementation(message => {
      if (message.payload.kind === "ack") { f.abort.abort(); throw new Error("peer gone"); }
    });
    const task = receiveSharedUnlockBrowserTransfer(f.transport, attemptId, async () => r);
    f.emit({ kind: "source-offer", publicKey: operation.sourcePublicKey }); await settle();
    f.emit({ kind: "handoff", ...packet }); expect(await task).toBe("own-session"); expect(r.installed()).toBe(true);
  });
});
