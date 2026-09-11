import type { SharedUnlockContext } from "@palladin/crypto";
import type { SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import { receiveSharedUnlockBrowserTransfer, sendSharedUnlockBrowserTransfer, type SharedUnlockOperationTransport } from "./browser-transfer";

type Payload = SharedUnlockOperationMessage["payload"];
type State = Extract<Payload, { kind: "state" }>;
type Link = Extract<Payload, { kind: "link" }>;
type Prepare = Extract<Payload, { kind: "prepare" }>;
export type SharedUnlockSelectedBinding = Pick<SharedUnlockContext, "accountId" | "organizationId" | "apiOrigin" | "webOrigin"
  | "extensionId" | "documentBinding" | "webGeneration" | "extensionGeneration" | "linkId" | "linkEpoch" | "preferenceRevision">;
type SourceFactory = Parameters<typeof sendSharedUnlockBrowserTransfer>[2];
type ReceiverFactory = Parameters<typeof receiveSharedUnlockBrowserTransfer>[2];
export interface SharedUnlockCoordinatorRoute extends SharedUnlockOperationTransport {
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly documentBinding: string;
  close(): void;
}

/** Product-owned session and storage boundaries. Browser input cannot choose own
 * tokens, create manual authority, clear a local barrier or replace an account. */
export interface SharedUnlockCoordinatorClient {
  readonly role: "web" | "extension";
  nonce(): Promise<string>;
  readState(): Promise<{ accountId: string | null; status: State["status"];
    source: { organizationId: string; generation: string } | null }>;
  subscribe(changed: () => void): () => void;
  /** Extension owns allocation; Web only adopts the exact browser-selected ID. */
  selectLink(accountId: string, proposedId?: string, direction?: "source" | "receiver"): Promise<string>;
  prepareSource(accountId: string, organizationId: string, linkId: string, signal: AbortSignal,
    assertCurrent: () => void): Promise<{ linkEpoch: number; preferenceRevision: number }>;
  checkReceiver(binding: SharedUnlockSelectedBinding, signal: AbortSignal): Promise<void>;
  source(binding: SharedUnlockSelectedBinding, signal: AbortSignal, assertCurrent: () => void): ReturnType<SourceFactory>;
  receiver(binding: SharedUnlockSelectedBinding, signal: AbortSignal, assertCurrent: () => void): ReturnType<ReceiverFactory>;
  /** Successful receiver metadata is local; the transport never serializes it. */
  received?(result: unknown, binding: SharedUnlockSelectedBinding): void;
}

/** One verified document, one pending attempt, no persistent message queue.
 * Selection is agreed before the crypto offer; operation/envelope fields never
 * supply expected account, browser, document, generation or link identity. */
export function startSharedUnlockBrowserCoordinator(route: SharedUnlockCoordinatorRoute, client: SharedUnlockCoordinatorClient) {
  let stopped = false;
  let own: State | null = null, peer: State | null = null, selected: Link | null = null;
  let version = 0, ownRevision = 0;
  let selectionRunning = false, refreshRunning = false, refreshAgain = false, sourceRefreshNeeded = false;
  let attempted: string | null = null;
  let active: { id: string; direction: "source" | "receiver"; abort: AbortController;
    timer: ReturnType<typeof setTimeout>; binding: SharedUnlockSelectedBinding | null; prepared: (() => void) | null } | null = null;
  const assertCurrent = () => { if (stopped || route.signal.aborted) throw new Error("Shared unlock coordinator retired"); route.assertCurrent(); };
  const cancel = () => {
    const previous = active; active = null;
    if (previous) { clearTimeout(previous.timer); previous.abort.abort(); }
  };
  const close = () => {
    if (stopped) return; stopped = true; version++; cancel();
    unsubscribe(); unwatch(); route.signal.removeEventListener("abort", close);
  };
  const fail = () => { close(); route.close(); };
  const send = (attemptId: string, payload: Payload) => { assertCurrent(); route.sendOperation({ attemptId, payload }); };
  const pair = () => {
    if (!own || !peer) return null;
    const web = client.role === "web" ? own : peer, extension = client.role === "extension" ? own : peer;
    const source = web.status === "unlocked" && web.source ? web
      : extension.status === "unlocked" && extension.source ? extension : null;
    if (!source?.accountId) return null;
    const receiver = source === web ? extension : web;
    if (receiver.status === "unlocked" || (receiver.accountId !== null && receiver.accountId !== source.accountId)) return null;
    return { web, extension, source, accountId: source.accountId, organizationId: source.source!.organizationId,
      ownSource: source === own };
  };
  const matches = (link: Link) => {
    const current = pair();
    return current && current.web.stateId === link.webStateId && current.extension.stateId === link.extensionStateId
      && current.accountId === link.accountId ? current : null;
  };
  const binding = (offer: Prepare): SharedUnlockSelectedBinding => {
    const current = selected && matches(selected);
    if (!current || selected!.linkId !== offer.linkId || current.accountId !== offer.accountId
      || current.organizationId !== offer.organizationId || current.web.stateId !== offer.webStateId
      || current.extension.stateId !== offer.extensionStateId) throw new Error("Shared unlock selection changed");
    return { accountId: current.accountId, organizationId: current.organizationId, apiOrigin: new URL(route.apiUrl).origin,
      webOrigin: route.webOrigin, extensionId: route.extensionId, documentBinding: route.documentBinding,
      webGeneration: current.web.generation, extensionGeneration: current.extension.generation,
      linkId: offer.linkId, linkEpoch: offer.linkEpoch, preferenceRevision: offer.preferenceRevision };
  };
  const begin = (id: string, direction: "source" | "receiver") => {
    if (active) throw new Error("Shared unlock attempt already active");
    const abort = new AbortController(), revision = version, deadline = Date.now() + 30_000;
    const attempt = { id, direction, abort, timer: setTimeout(() => { abort.abort(); }, 30_000),
      binding: null as SharedUnlockSelectedBinding | null, prepared: null as (() => void) | null };
    active = attempt;
    const check = () => { assertCurrent(); if (active !== attempt || abort.signal.aborted || revision !== version || Date.now() >= deadline) throw new Error("Shared unlock attempt changed"); };
    return { attempt, check };
  };
  const waitAttempt = <T>(attempt: NonNullable<typeof active>, promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error("Shared unlock attempt cancelled"));
    if (attempt.abort.signal.aborted) cancelled();
    else attempt.abort.signal.addEventListener("abort", cancelled, { once: true });
    promise.then(resolve, reject).finally(() => attempt.abort.signal.removeEventListener("abort", cancelled));
  });
  const transport = (attempt: NonNullable<typeof active>, check: () => void): SharedUnlockOperationTransport => ({
    signal: AbortSignal.any([route.signal, attempt.abort.signal]), assertCurrent: check,
    verifyCurrent: async () => { await route.verifyCurrent(); check(); },
    sendOperation: message => { check(); route.sendOperation(message); },
    onOperation: listener => route.onOperation(listener),
  });
  const finish = (attempt: NonNullable<typeof active>) => {
    if (active === attempt) cancel();
    if (refreshAgain) void refresh();
  };
  const startSource = async () => {
    const current = selected && matches(selected);
    if (!current?.ownSource || active || !selected) return;
    const candidate = selected, revision = version;
    const fingerprint = JSON.stringify(candidate);
    if (attempted === fingerprint) return;
    attempted = fingerprint;
    const id = await client.nonce(); assertCurrent();
    if (version !== revision || selected !== candidate || active) return;
    const { attempt, check } = begin(id, "source");
    try {
      const prepared = new Promise<void>((resolve, reject) => {
        attempt.prepared = resolve;
        attempt.abort.signal.addEventListener("abort", () => reject(new Error("Shared unlock preparation cancelled")), { once: true });
      });
      void prepared.catch(() => {});
      const scope = await waitAttempt(attempt, client.prepareSource(current.accountId, current.organizationId, candidate.linkId, attempt.abort.signal, check)); check();
      const offer: Prepare = { kind: "prepare", webStateId: candidate.webStateId, extensionStateId: candidate.extensionStateId,
        accountId: current.accountId, organizationId: current.organizationId, linkId: candidate.linkId, ...scope };
      attempt.binding = binding(offer);
      await route.verifyCurrent(); check(); send(id, offer);
      await prepared; check();
      await sendSharedUnlockBrowserTransfer(transport(attempt, check), id, signal => client.source(attempt.binding!, AbortSignal.any([signal, attempt.abort.signal]), check));
    } catch { /* Ordinary own session remains intact; no automatic repeat of this attempt. */ }
    finally { finish(attempt); }
  };
  const select = async () => {
    if (selectionRunning || client.role !== "extension") return;
    const current = pair(); if (!current) return;
    const revision = version;
    selectionRunning = true;
    try {
      const linkId = await client.selectLink(current.accountId, undefined, current.ownSource ? "source" : "receiver"); assertCurrent();
      if (version !== revision) return;
      selected = { kind: "link", accountId: current.accountId, linkId, webStateId: current.web.stateId, extensionStateId: current.extension.stateId };
      await route.verifyCurrent(); assertCurrent(); if (version !== revision) return;
      send(current.extension.stateId, selected);
    } catch { /* Local closing/disconnect/storage failure prevents admission. */ }
    finally { selectionRunning = false; if (version !== revision && !stopped) void select(); }
  };
  const refresh = async () => {
    if (stopped) return;
    if (refreshRunning || active?.direction === "receiver") { refreshAgain = true; return; }
    refreshRunning = true; refreshAgain = false;
    const revision = ownRevision;
    try {
      const state = await client.readState(); assertCurrent();
      if (revision !== ownRevision) { refreshAgain = true; return; }
      if (!sourceRefreshNeeded && own && own.accountId === state.accountId && own.status === state.status
        && own.source?.organizationId === state.source?.organizationId && (!state.source || own.generation === state.source.generation)) return;
      const stateId = await client.nonce(), generation = state.source?.generation ?? await client.nonce(); assertCurrent();
      if (revision !== ownRevision) { refreshAgain = true; return; }
      sourceRefreshNeeded = false;
      version++; cancel(); selected = null; attempted = null;
      own = { kind: "state", stateId, generation, accountId: state.accountId, status: state.status,
        source: state.source ? { organizationId: state.source.organizationId } : null };
      await route.verifyCurrent(); assertCurrent(); send(stateId, own); void select();
    } catch { fail(); }
    finally { refreshRunning = false; if (refreshAgain && !stopped) void refresh(); }
  };
  const receive = async (message: SharedUnlockOperationMessage) => {
    const payload = message.payload;
    if (payload.kind === "state") {
      if (message.attemptId !== payload.stateId || (payload.source && (payload.status !== "unlocked" || !payload.accountId))
        || (payload.status !== "signed-out" && !payload.accountId) || (payload.status === "signed-out" && payload.accountId)) throw new Error("Invalid peer state");
      if (peer?.stateId === payload.stateId) return;
      version++; cancel(); selected = null; attempted = null; peer = payload; void select(); return;
    }
    if (payload.kind === "link") {
      if (client.role !== "web" || !matches(payload) || message.attemptId !== payload.extensionStateId) throw new Error("Invalid link selection");
      if (selected && selected.linkId === payload.linkId && selected.webStateId === payload.webStateId
        && selected.extensionStateId === payload.extensionStateId) return;
      if (selectionRunning) throw new Error("Shared unlock link selection already pending");
      selectionRunning = true;
      const revision = version;
      try {
        try { await client.selectLink(payload.accountId, payload.linkId, matches(payload)!.ownSource ? "source" : "receiver"); }
        catch { return; } // Local OFF/disconnect is a recoverable admission denial.
        assertCurrent(); if (revision !== version) return;
        selected = payload;
        await route.verifyCurrent(); assertCurrent(); if (revision !== version) return;
        send(payload.extensionStateId, { ...payload, kind: "link-selected" });
      } finally { selectionRunning = false; }
      await startSource(); return;
    }
    if (payload.kind === "link-selected") {
      if (client.role !== "extension" || !selected || !matches(selected) || payload.linkId !== selected.linkId
        || payload.accountId !== selected.accountId || payload.webStateId !== selected.webStateId
        || payload.extensionStateId !== selected.extensionStateId || message.attemptId !== selected.extensionStateId) throw new Error("Invalid link acknowledgement");
      await startSource(); return;
    }
    if (payload.kind === "prepared") {
      if (active?.direction === "source" && active.id === message.attemptId && active.binding) {
        active.prepared?.(); active.prepared = null;
      }
      return;
    }
    if (payload.kind === "prepare") {
      if (active || !selected || !matches(selected) || matches(selected)!.ownSource) throw new Error("Unexpected source preparation");
      const chosen = binding(payload), { attempt, check } = begin(message.attemptId, "receiver");
      attempt.binding = chosen;
      try {
        await waitAttempt(attempt, client.checkReceiver(chosen, attempt.abort.signal)); check();
        // Subscribe before announcing readiness; the runner waits for source offer.
        const transfer = receiveSharedUnlockBrowserTransfer(transport(attempt, check), attempt.id,
          signal => client.receiver(chosen, AbortSignal.any([signal, attempt.abort.signal]), check));
        void transfer.catch(() => {});
        try { await route.verifyCurrent(); check(); send(attempt.id, { kind: "prepared" }); }
        catch { attempt.abort.abort(); }
        const result = await transfer;
        // Installation has its own final fence. Peer close after that point must
        // not prevent local adoption of an independently valid receiver root.
        client.received?.(result, chosen);
      } catch (error) {
        if (!attempt.abort.signal.aborted) throw error;
      } finally { refreshAgain = true; finish(attempt); }
      return;
    }
    if (payload.kind === "cancel" && active?.id === message.attemptId) active.abort.abort();
    // Crypto offer/handoff/ACK frames belong to the one-shot transfer subscriber.
  };
  const unsubscribe = route.onOperation(message => { void receive(message).catch(fail); });
  const unwatch = client.subscribe(() => {
    ownRevision++;
    if (active?.direction === "source") {
      // Cancellation consumes the old selection; advertise a fresh state even
      // when an own authority update keeps the same account/key generation.
      sourceRefreshNeeded = true;
      cancel();
    }
    void refresh();
  });
  route.signal.addEventListener("abort", close, { once: true });
  void refresh();
  return { close, cancelPending: (accountId: string) => {
    if (stopped || (own?.accountId ?? selected?.accountId ?? peer?.accountId) !== accountId) return;
    version++; ownRevision++; cancel(); selected = null; attempted = null; own = null;
    void refresh();
  } };
}
