import { SharedUnlockApi, SharedUnlockApiError } from "./api";
import { SharedUnlockLinkStore, type SharedUnlockLinkScope } from "./link-store";

export interface SharedUnlockClosingSession {
  readonly apiUrl: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}
export interface SharedUnlockLinkChange { readonly accountId: string; readonly linkId: string; readonly apiUrl: string }
const listeners = new Set<(change: SharedUnlockLinkChange) => void | Promise<void>>();
export function subscribeSharedUnlockLinkChanges(listener: (change: SharedUnlockLinkChange) => void | Promise<void>): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
async function changed(scope: SharedUnlockLinkScope, linkId: string): Promise<void> {
  await Promise.allSettled([...listeners].map(async listener => {
    await listener({ accountId: scope.accountId, apiUrl: scope.apiUrl, linkId });
  }));
}

/** Caller owns a bounded signal and its exact own Identity session. A fresh
 * manual proof is authorized only AFTER this completes, so its sequence is newer. */
export async function flushSharedUnlockClosings(scope: SharedUnlockLinkScope, session: SharedUnlockClosingSession,
  store: SharedUnlockLinkStore, api: SharedUnlockApi, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
  const selected = { ...scope };
  const check = () => {
    if (signal.aborted || session.userId !== selected.accountId || session.apiUrl !== selected.apiUrl) throw new SharedUnlockApiError("cancelled");
    assertCurrent();
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => reject(new SharedUnlockApiError("cancelled"));
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
  check();
  let marker = await wait(store.repair(selected)); check();
  if (!marker?.pending.length) return;
  // Snapshot IDs bounds this pass; a newer local decision is never acknowledged.
  for (const intent of [...marker.pending]) {
    check(); marker = await wait(store.read(selected)); check();
    if (!marker || !marker.pending.some(current => current.id === intent.id)) continue;
    const preference = await wait(api.readPreference(session, signal)); check();
    if (intent.action !== "disconnect" && !preference.sharedUnlockEnabled) {
      await wait(store.acknowledgeDisabledClosing(selected, marker.linkId, intent.id)); check(); continue;
    }
    const link = await wait(api.readLink(session, marker.linkId, signal)); check();
    await wait(store.observe(selected, link)); check();
    const current = await wait(store.read(selected)); check();
    if (!current?.pending.some(value => value.id === intent.id)) continue;
    // A CAS conflict remains pending. Never replay a mutation with guessed authority.
    const result = intent.action === "lock" ? await wait(api.lock(session, link.linkId, link.revision, preference.revision, signal))
      : intent.action === "logout" ? await wait(api.logout(session, link.linkId, link.revision, preference.revision, signal))
      : await wait(api.disconnect(session, link.linkId, link.revision, signal));
    check();
    await wait(store.acknowledgeClosing(selected, link.linkId, intent.id, result)); check();
    await wait(changed(selected, link.linkId)); check();
  }
  const remaining = await wait(store.read(selected)); check();
  if (remaining?.pending.length) throw new SharedUnlockApiError("conflict");
}

/** Network delivery may time out, but the durable intent remains for repair. */
export async function deliverSharedUnlockClosings(scopes: readonly SharedUnlockLinkScope[], session: SharedUnlockClosingSession,
  store: SharedUnlockLinkStore, api: SharedUnlockApi, assertCurrent: () => void): Promise<void> {
  const abort = new AbortController(), deadline = Date.now() + 2000;
  const timeout = setTimeout(() => abort.abort(), 2000);
  const check = () => { if (Date.now() >= deadline) throw new SharedUnlockApiError("cancelled"); assertCurrent(); };
  try {
    for (const scope of scopes) {
      check(); await flushSharedUnlockClosings(scope, session, store, api, abort.signal, check);
    }
  } catch { /* Own logout proceeds; only acknowledged intents have been removed. */ }
  finally { abort.abort(); clearTimeout(timeout); }
}
