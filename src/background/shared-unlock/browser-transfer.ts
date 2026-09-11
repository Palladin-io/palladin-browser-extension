import type { SharedUnlockEnvelope } from "@palladin/crypto";
import type { SharedUnlockOperation as Operation } from "./api-types";
import type { SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";

interface Acknowledgement { operationId: string; webGeneration: string; extensionGeneration: string }
export interface SharedUnlockOperationTransport {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  verifyCurrent(): Promise<void>;
  sendOperation(message: SharedUnlockOperationMessage): void;
  onOperation(listener: (message: SharedUnlockOperationMessage) => void): () => void;
}
interface Source {
  readonly publicKey: string;
  cancel(): void;
  send(input: { recipientPublicKey: string; recipientProofPublicKey: string; verifyRecipient(): Promise<void>;
    send(packet: { operation: Operation; envelope: SharedUnlockEnvelope }): void }): Promise<Acknowledgement>;
}
interface Receiver<T> {
  readonly publicKey: string;
  readonly proofPublicKey: string;
  cancel(): void;
  receive(input: { operation: Operation; verifiedSourcePublicKey: string; envelope(signal: AbortSignal): Promise<unknown>;
    acknowledge(result: Acknowledgement): void }): Promise<T>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function lifetime(transport: SharedUnlockOperationTransport, stop: () => void) {
  const abort = new AbortController();
  const deadline = Date.now() + 30_000;
  const cancel = () => { if (!abort.signal.aborted) { abort.abort(); stop(); } };
  transport.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 30_000);
  const check = () => {
    if (transport.signal.aborted || abort.signal.aborted || Date.now() >= deadline) throw new Error("Shared unlock transfer cancelled");
    transport.assertCurrent();
    if (transport.signal.aborted || abort.signal.aborted || Date.now() >= deadline) throw new Error("Shared unlock transfer cancelled");
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const stopped = () => reject(new Error("Shared unlock transfer cancelled"));
    if (abort.signal.aborted) stopped();
    else abort.signal.addEventListener("abort", stopped, { once: true });
    promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", stopped));
  });
  return { signal: abort.signal, cancel, check, wait,
    close() { clearTimeout(timeout); transport.signal.removeEventListener("abort", cancel); } };
}

/** The caller supplies independently selected account/link/generation authority
 * to createSource; this exchange never derives it from operation or envelope. */
export async function sendSharedUnlockBrowserTransfer(transport: SharedUnlockOperationTransport, attemptId: string,
  createSource: (signal: AbortSignal) => Promise<Source>) {
  let source: Source | null = null;
  let phase: "initial" | "offer" | "sending" | "ack" = "initial";
  let sent: Acknowledgement | null = null;
  const offered = deferred<{ publicKey: string; proofPublicKey: string }>();
  const acknowledged = deferred<boolean>();
  const life = lifetime(transport, () => {
    source?.cancel(); offered.reject(new Error("Shared unlock transfer cancelled")); acknowledged.resolve(false);
  });
  let unsubscribe = () => {};
  try {
    life.check();
    unsubscribe = transport.onOperation(message => {
      if (message.attemptId !== attemptId) return;
      const payload = message.payload;
      if (payload.kind === "cancel") { life.cancel(); return; }
      try {
        life.check();
        if (phase === "offer" && payload.kind === "receiver-offer") {
          phase = "sending"; offered.resolve(payload); return;
        }
        if (phase === "ack" && payload.kind === "ack" && sent && payload.operationId === sent.operationId
          && payload.webGeneration === sent.webGeneration && payload.extensionGeneration === sent.extensionGeneration) {
          acknowledged.resolve(true); return;
        }
        life.cancel();
      } catch { life.cancel(); }
    });
    life.check();
    const activeSource = await life.wait(createSource(life.signal).then(value => { if (life.signal.aborted) value.cancel(); return value; }));
    source = activeSource;
    life.check();
    await life.wait(transport.verifyCurrent()); life.check();
    phase = "offer";
    transport.sendOperation({ attemptId, payload: { kind: "source-offer", publicKey: activeSource.publicKey } });
    const recipient = await life.wait(offered.promise); life.check();
    await activeSource.send({ recipientPublicKey: recipient.publicKey, recipientProofPublicKey: recipient.proofPublicKey,
      verifyRecipient: async () => { await life.wait(transport.verifyCurrent()); life.check(); },
      send: packet => {
        life.check();
        sent = { operationId: packet.operation.context.operationId, webGeneration: packet.operation.context.webGeneration,
          extensionGeneration: packet.operation.context.extensionGeneration };
        phase = "ack";
        transport.sendOperation({ attemptId, payload: { kind: "handoff", ...packet } });
      },
    });
    const ack = await acknowledged.promise;
    return { ...sent!, acknowledged: ack };
  } finally {
    unsubscribe(); life.cancel(); life.close();
  }
}

/** Receiver crypto/Identity/session installation remains inside createReceiver's
 * existing transaction. The transport ACK never owns or installs that session. */
export async function receiveSharedUnlockBrowserTransfer<T>(transport: SharedUnlockOperationTransport, attemptId: string,
  createReceiver: (signal: AbortSignal) => Promise<Receiver<T>>): Promise<T> {
  let receiver: Receiver<T> | null = null;
  let phase: "offer" | "preparing" | "handoff" | "installing" = "offer";
  const offered = deferred<string>();
  const handoff = deferred<{ operation: Operation; envelope: SharedUnlockEnvelope }>();
  const life = lifetime(transport, () => {
    receiver?.cancel(); offered.reject(new Error("Shared unlock transfer cancelled")); handoff.reject(new Error("Shared unlock transfer cancelled"));
  });
  let unsubscribe = () => {};
  try {
    life.check();
    unsubscribe = transport.onOperation(message => {
      if (message.attemptId !== attemptId) return;
      const payload = message.payload;
      if (payload.kind === "cancel") { life.cancel(); return; }
      try {
        life.check();
        if (phase === "offer" && payload.kind === "source-offer") {
          phase = "preparing"; offered.resolve(payload.publicKey); return;
        }
        if (phase === "handoff" && payload.kind === "handoff") {
          phase = "installing"; handoff.resolve(payload); return;
        }
        life.cancel();
      } catch { life.cancel(); }
    });
    life.check();
    const publicKey = await life.wait(offered.promise); life.check();
    const activeReceiver = await life.wait(createReceiver(life.signal).then(value => { if (life.signal.aborted) value.cancel(); return value; }));
    receiver = activeReceiver;
    life.check(); await life.wait(transport.verifyCurrent()); life.check();
    phase = "handoff";
    transport.sendOperation({ attemptId, payload: { kind: "receiver-offer", publicKey: activeReceiver.publicKey, proofPublicKey: activeReceiver.proofPublicKey } });
    const packet = await life.wait(handoff.promise); life.check();
    // Do not race local installation against transport cancellation: the actual
    // transaction owns rollback and the precise successful completion boundary.
    return await activeReceiver.receive({ operation: packet.operation, verifiedSourcePublicKey: publicKey,
      envelope: async () => { life.check(); return packet.envelope; },
      acknowledge: result => {
        transport.assertCurrent();
        transport.sendOperation({ attemptId, payload: { kind: "ack", operationId: result.operationId,
          webGeneration: result.webGeneration, extensionGeneration: result.extensionGeneration } });
      },
    });
  } finally {
    unsubscribe(); life.cancel(); life.close();
  }
}
