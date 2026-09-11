import { randomBytes, toBase64Url, wipe } from "@palladin/crypto";
import type { ManualUnlockContext } from "../session/manual-unlock";
import type { SharedUnlockApiErrorCode } from "./api";
import { SharedUnlockApi, SharedUnlockApiError } from "./api";
import type { SharedUnlockAuthorization, SharedUnlockPreference } from "./api-types";

export interface SharedUnlockSourceState {
  readonly preference: SharedUnlockPreference | null;
  readonly authorization: SharedUnlockAuthorization | null;
  readonly sourceGeneration: string | null;
  readonly failure: SharedUnlockApiErrorCode | null;
}

/** Own verified manual or inherited receiver authority. No peer can ask this class to derive a proof. */
export class SharedUnlockSourceAuthority {
  private version = 0;
  private controller: AbortController | null = null;
  private pendingProof: Uint8Array | null = null;
  private state: SharedUnlockSourceState = { preference: null, authorization: null, sourceGeneration: null, failure: null };
  private checkSession: (() => void) | null = null;

  constructor(private readonly api: SharedUnlockApi, private readonly now: () => number = Date.now,
    private readonly beforeAuthorize?: (session: ManualUnlockContext["tokens"], signal: AbortSignal, check: () => void) => Promise<void>,
    private readonly onAuthorized?: (authorization: SharedUnlockAuthorization, session: ManualUnlockContext["tokens"]) => void | number | Promise<number>) {}

  private closingRoot: { authorizationId: string; sequence: number; sourceGeneration: string } | null = null;
  /** RAM-only closing witness for this own key generation. Expiry removes sharing
   * authority, but must not disable authenticated lock/logout repair. */
  closingWitness() {
    try { this.checkSession?.(); } catch { this.reset(); }
    return this.closingRoot ? { ...this.closingRoot } : null;
  }

  private readonly activities = new Set<symbol>();
  /** Borrowed own RAM authority for input already admitted by the local key
   * session. A pending own renewal never advertises an expired source to peers. */
  captureActivity() {
    this.checkSession?.();
    const root = this.state.authorization, generation = this.state.sourceGeneration;
    if (!root || !generation || (this.activities.size === 0 && this.now() >= Math.min(root.idleDeadlineMs, root.absoluteDeadlineMs, root.offlineDeadlineMs))) {
      throw new SharedUnlockApiError("cancelled");
    }
    const version = this.version, ticket = Symbol();
    this.activities.add(ticket);
    const assertCurrent = () => {
      if (version !== this.version || !this.activities.has(ticket) || this.state.authorization?.authorizationId !== root.authorizationId
        || this.state.sourceGeneration !== generation) throw new SharedUnlockApiError("cancelled");
      this.checkSession?.();
      if (version !== this.version || !this.activities.has(ticket)) throw new SharedUnlockApiError("cancelled");
    };
    return { authorization: { ...root }, generation, assertCurrent,
      apply: (authorization: SharedUnlockAuthorization) => { assertCurrent(); this.state = { ...this.state, authorization: { ...authorization } }; this.notify(); },
      dispose: () => { this.activities.delete(ticket); },
    };
  }

  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Sharing observers cannot undo own login/unlock. */ }
    }
  }
  /** Only the verified local receiver transaction supplies this own inherited
   * root. This never derives a password proof or renews original ceilings. */
  adopt(authorization: SharedUnlockAuthorization, generation: string, preference: SharedUnlockPreference,
    assertOwnCurrent: () => void): void {
    assertOwnCurrent();
    const selectedPreference = this.state.preference && this.state.preference.revision > preference.revision
      ? { ...this.state.preference } : { ...preference };
    this.reset();
    assertOwnCurrent();
    this.checkSession = assertOwnCurrent;
    this.closingRoot = { authorizationId: authorization.authorizationId, sequence: authorization.sequence, sourceGeneration: generation };
    this.state = { authorization: { ...authorization }, preference: selectedPreference, sourceGeneration: generation, failure: null };
    this.notify();
  }

  reset(): void {
    this.closingRoot = null;
    this.activities.clear();
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.pendingProof) wipe(this.pendingProof);
    this.pendingProof = null;
    this.checkSession = null;
    this.state = { preference: null, authorization: null, sourceGeneration: null, failure: null };
    this.notify();
  }

  snapshot(): SharedUnlockSourceState {
    try {
      this.checkSession?.();
      const a = this.state.authorization;
      if (a && this.now() >= Math.min(a.idleDeadlineMs, a.absoluteDeadlineMs, a.offlineDeadlineMs)) {
        const expired = { ...this.state, authorization: null, sourceGeneration: null };
        if (!this.activities.size) this.state = expired;
        return { ...expired, preference: expired.preference ? { ...expired.preference } : null };
      }
    } catch { this.reset(); }
    return { ...this.state,
      preference: this.state.preference ? { ...this.state.preference } : null,
      authorization: this.state.authorization ? { ...this.state.authorization } : null };
  }

  /** Fresh authenticated preference for this existing own generation. This
   * cannot manufacture a root, re-enable an older revision or renew its limits. */
  acceptPreference(preference: SharedUnlockPreference, sourceGeneration: string): void {
    const current = this.snapshot();
    if (!current.authorization || current.sourceGeneration !== sourceGeneration) throw new SharedUnlockApiError("cancelled");
    if (current.preference && preference.revision < current.preference.revision) return;
    this.state = { ...this.state, preference: { sharedUnlockEnabled: preference.sharedUnlockEnabled, revision: preference.revision } };
  }

  /** Failed preparation disables sharing, while SessionManager may unlock itself. */
  async prepare(context: ManualUnlockContext): Promise<SharedUnlockAuthorization | null> {
    this.reset();
    const version = this.version;
    const controller = new AbortController(); this.controller = controller;
    this.pendingProof = context.authCredential;
    const deadline = Date.now() + 10_000;
    const timeout = setTimeout(() => { controller.abort(); wipe(context.authCredential); }, 10_000);
    const check = () => {
      if (version !== this.version || controller.signal.aborted || Date.now() >= deadline) throw new SharedUnlockApiError("cancelled");
      context.assertCurrent();
      if (version !== this.version || controller.signal.aborted || Date.now() >= deadline) throw new SharedUnlockApiError("cancelled");
    };
    try {
      check();
      const account = context.account;
      if (account.userId !== context.tokens.userId || !account.kdf) throw new SharedUnlockApiError("unauthorized");
      const bytes = await randomBytes(32);
      const generation = toBase64Url(bytes); wipe(bytes);
      check();
      await this.beforeAuthorize?.(context.tokens, controller.signal, check);
      check();
      const preference = await this.api.readPreference(context.tokens, controller.signal);
      check();
      this.state = { preference, authorization: null, sourceGeneration: null, failure: null };
      let authorization = await this.api.authorize(context.tokens, {
        authCredential: toBase64Url(context.authCredential), sourceGeneration: generation,
        expectedPreferenceRevision: preference.revision,
        expectedCredentialRevision: account.kdf.credentialRevision,
        expectedPrivateKeyWrapRevision: account.kdf.privateKeyWrapRevision,
        idleDeadlineMs: context.limits.idleDeadlineMs, absoluteDeadlineMs: context.limits.absoluteDeadlineMs,
        offlineDeadlineMs: context.limits.offlineDeadlineMs,
      }, controller.signal);
      check();
      const persistedDeadline = await new Promise<void | number>((resolve, reject) => {
        const cancelled = () => reject(new SharedUnlockApiError("cancelled"));
        if (controller.signal.aborted) { cancelled(); return; }
        controller.signal.addEventListener("abort", cancelled, { once: true });
        Promise.resolve().then(() => { check(); return this.onAuthorized?.(authorization, context.tokens); })
          .then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancelled));
      });
      if (persistedDeadline !== undefined) authorization = { ...authorization, idleDeadlineMs: Math.min(authorization.idleDeadlineMs, persistedDeadline) };
      check();
      this.closingRoot = { authorizationId: authorization.authorizationId, sequence: authorization.sequence, sourceGeneration: generation };
      this.checkSession = context.assertCurrent;
      this.state = { preference, authorization, sourceGeneration: generation, failure: null };
      return authorization;
    } catch (error) {
      if (version === this.version) this.state = { ...this.state, authorization: null, sourceGeneration: null,
        failure: error instanceof SharedUnlockApiError ? error.code : "cancelled" };
      return null;
    } finally {
      clearTimeout(timeout);
      wipe(context.authCredential);
      if (this.pendingProof === context.authCredential) this.pendingProof = null;
      if (this.controller === controller) this.controller = null;
      this.notify();
    }
  }
}
