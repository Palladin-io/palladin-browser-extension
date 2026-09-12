import type { SharedUnlockCoordinatorRoute } from "./browser-coordinator";
import { SharedUnlockApi } from "./api";
import { subscribeSharedUnlockLinkChanges, type SharedUnlockClosingSession } from "./closing";
import { SharedUnlockLinkStore } from "./link-store";
import type { SharedUnlockManualLockCheckpoint } from './manual-lock-checkpoint';

export interface SharedUnlockLinkMonitorClient {
  nonce(): Promise<string>;
  subscribe(changed: () => void): () => void;
  capture(): { session: SharedUnlockClosingSession; sequence: number | undefined; signal: AbortSignal;
    manualLockCheckpoints?: readonly SharedUnlockManualLockCheckpoint[] | null;
    assertCurrent(): void; dispose(): void } | null;
  closeSession(action: "lock" | "logout"): Promise<void>;
}

/** Peer frames are only hints. A live own root can compare Identity barriers;
 * without it Identity must resolve the captured own logical session itself. */
export function startSharedUnlockLinkMonitor(route: SharedUnlockCoordinatorRoute, client: SharedUnlockLinkMonitorClient,
  store: SharedUnlockLinkStore, api: SharedUnlockApi) {
  let stopped = false, running = false, outgoing = false, again = false;
  let abort: AbortController | null = null;
  let nextReadAt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const request = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    if (Date.now() < nextReadAt) {
      retry ??= setTimeout(() => { retry = null; request(); }, nextReadAt - Date.now()); return;
    }
    void repair();
  };
  const repair = async () => {
    if (stopped || running) return;
    running = true; again = false; nextReadAt = Date.now() + 1000;
    let own: ReturnType<SharedUnlockLinkMonitorClient["capture"]> = null;
    const controller = new AbortController(); abort = controller;
    const timeout = setTimeout(() => controller.abort(), 2000);
    const deadline = Date.now() + 2000;
    try {
      route.assertCurrent(); own = client.capture(); if (!own) return;
      const captured = own;
      const signal = AbortSignal.any([route.signal, captured.signal, controller.signal]);
      const check = () => { if (stopped || signal.aborted || Date.now() >= deadline) throw new Error("Shared link repair cancelled"); route.assertCurrent(); captured.assertCurrent(); };
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const cancel = () => reject(new Error("Shared link repair cancelled"));
        if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
      });
      const scope = { accountId: captured.session.userId, apiUrl: route.apiUrl, webOrigin: route.webOrigin, extensionId: route.extensionId };
      check();
      if (captured.session.apiUrl !== route.apiUrl) return;
      const marker = await wait(store.read(scope)); check();
      if (!marker) return;
      const sequence = captured.sequence;
      const state = sequence === undefined
        ? await wait(api.readSessionState(captured.session, marker.linkId, signal))
        : await wait(api.readLink(captured.session, marker.linkId, signal)).then(link => ({ link,
          action: sequence <= link.lastLogoutSequence ? "logout" as const
            : sequence <= link.lastInvalidationSequence ? "lock" as const : "none" as const }));
      check();
      const { link } = state;
      const acknowledgedManualLock = sequence === undefined && state.action === 'lock' && link
        && captured.manualLockCheckpoints?.some(prior => prior.linkId === marker.linkId && prior.linkId === link.linkId
          && link.lastInvalidationSequence <= prior.lastInvalidationSequence);
      const action = state.action === "none" || acknowledgedManualLock ? null : state.action;
      if (action) {
        // Invoke the synchronous local wipe before any durable observation wait.
        const closed = client.closeSession(action);
        if (link) void store.observe(scope, link).catch(() => {});
        await closed;
      } else if (link) { await wait(store.observe(scope, link)); }
    } catch { /* Transport/storage failure grants no new authority and does not invent a group action. */ }
    finally {
      clearTimeout(timeout); own?.dispose(); controller.abort(); if (abort === controller) abort = null;
      running = false; if (again && !stopped) request();
    }
  };
  const removers: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (stopped) return; stopped = true; abort?.abort();
    if (timer) clearInterval(timer);
    if (retry) clearTimeout(retry);
    for (const remove of removers) remove();
    route.signal.removeEventListener("abort", close);
  };
  try {
    removers.push(client.subscribe(request));
    removers.push(route.onOperation(message => {
      if (message.payload.kind === "link-invalidated") request();
    }));
    removers.push(subscribeSharedUnlockLinkChanges(change => {
      if (stopped || outgoing || change.apiUrl !== route.apiUrl) return;
      outgoing = true;
      return (async () => {
        try {
          const id = await client.nonce(); await route.verifyCurrent();
          if (!stopped) route.sendOperation({ attemptId: id, payload: { kind: "link-invalidated" } });
        } catch { /* Reconnect/foreground repair recovers a lost nonsensitive hint. */ }
        finally { outgoing = false; }
      })();
    }));
    timer = setInterval(request, 15_000);
    route.signal.addEventListener("abort", close, { once: true });
    request();
  } catch (error) { close(); throw error; }
  return { close };
}
