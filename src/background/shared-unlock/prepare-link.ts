import type { SessionManager } from "../session/session-manager";
import type { SharedUnlockPreference } from "./api-types";
import { SharedUnlockApi, SharedUnlockApiError } from "./api";
import { SharedUnlockLinkStore, type SharedUnlockLinkScope } from "./link-store";
import type { SharedUnlockSourceAuthority } from "./source-authority";

export type SharedUnlockLinkUnavailableReason = "disabled" | "pending-closing" | "disconnected" | "missing-link";
export class SharedUnlockLinkUnavailable extends Error {
  constructor(readonly reason: SharedUnlockLinkUnavailableReason) { super("Shared unlock link unavailable"); }
}

/** Source-only preparation: a persisted marker never substitutes for fresh
 * Identity preference/link authority or for browser confirmation. */
export async function prepareSharedUnlockLink(input: {
  scope: SharedUnlockLinkScope;
  organizationId: string;
  signal: AbortSignal;
  verifyBrowser(): Promise<void>;
  assertCurrent(): void;
}, manager: SessionManager, authority: SharedUnlockSourceAuthority, api: SharedUnlockApi, store: SharedUnlockLinkStore) {
  const scope = { ...input.scope };
  const { organizationId, signal, verifyBrowser, assertCurrent } = input;
  const deadline = Date.now() + 30_000;
  const own = manager.captureSharedUnlockSource();
  const initial = authority.snapshot();
  const root = initial.authorization;
  const generation = initial.sourceGeneration;
  let acceptedPreference: SharedUnlockPreference | null = null;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const timeout = setTimeout(cancel, 30_000);
  signal.addEventListener("abort", cancel, { once: true });
  own.signal.addEventListener("abort", cancel, { once: true });
  function cancelled(): never { throw new SharedUnlockApiError("cancelled"); }
  const check = () => {
    if (abort.signal.aborted || signal.aborted || Date.now() >= deadline || !root || !generation) cancelled();
    assertCurrent();
    const session = own.read();
    const current = authority.snapshot();
    if (session.tokens.apiUrl !== scope.apiUrl || session.tokens.userId !== scope.accountId
      || root.accountId !== scope.accountId || root.organizationId !== organizationId
      || current.sourceGeneration !== generation || current.authorization?.authorizationId !== root.authorizationId
      || current.authorization.sequence !== root.sequence || current.authorization.accountId !== root.accountId
      || current.authorization.organizationId !== root.organizationId
      || current.authorization.authorizationVersion !== root.authorizationVersion
      || current.authorization.credentialRevision !== root.credentialRevision
      || current.authorization.privateKeyWrapRevision !== root.privateKeyWrapRevision
      || (acceptedPreference && (current.preference?.sharedUnlockEnabled !== true
        || current.preference.revision !== acceptedPreference.revision))
      || abort.signal.aborted || signal.aborted || Date.now() >= deadline) cancelled();
    return session.tokens;
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const stopped = () => reject(new SharedUnlockApiError("cancelled"));
    if (abort.signal.aborted) stopped();
    else abort.signal.addEventListener("abort", stopped, { once: true });
    promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", stopped));
  });
  const admissible = async (linkId: string) => {
    check();
    const marker = await wait(store.read(scope));
    check();
    if (!marker || marker.linkId !== linkId) cancelled();
    if (marker.pending.length) throw new SharedUnlockLinkUnavailable("pending-closing");
    if (marker.disconnectId || marker.observed?.state === "revoked") throw new SharedUnlockLinkUnavailable("disconnected");
    return marker;
  };
  try {
    check();
    await wait(verifyBrowser());
    const preference = await wait(api.readPreference(check(), abort.signal));
    check();
    authority.acceptPreference(preference, generation!);
    if (!authority.snapshot().preference?.sharedUnlockEnabled) throw new SharedUnlockLinkUnavailable("disabled");
    acceptedPreference = preference;
    check();
    const marker = await wait(store.ensure(scope));
    await admissible(marker.linkId);
    let link;
    try { link = await wait(api.readLink(check(), marker.linkId, abort.signal)); }
    catch (error) {
      if (!(error instanceof SharedUnlockApiError) || error.code !== "not-found") throw error;
      const current = await admissible(marker.linkId);
      if (current.observed) throw new SharedUnlockLinkUnavailable("missing-link");
      link = await wait(api.createLink(check(), marker.linkId, preference.revision, abort.signal));
    }
    check();
    await wait(store.observe(scope, link));
    await admissible(marker.linkId);
    const active = await wait(api.activate(check(), marker.linkId, {
      authorizationId: root!.authorizationId, sourceGeneration: generation!, expectedRevision: link.revision,
      expectedPreferenceRevision: preference.revision,
    }, abort.signal));
    check();
    await wait(store.observe(scope, active));
    await admissible(marker.linkId);
    await wait(verifyBrowser());
    const latest = await admissible(marker.linkId);
    if (latest.observed?.revision !== active.revision) cancelled();
    check();
    return { link: active, preference, sourceGeneration: generation! };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    own.signal.removeEventListener("abort", cancel);
    own.dispose();
  }
}
