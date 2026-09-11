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

/** Own fresh manual authority only. No peer can ask this class to derive a proof. */
export class SharedUnlockSourceAuthority {
  private version = 0;
  private controller: AbortController | null = null;
  private pendingProof: Uint8Array | null = null;
  private state: SharedUnlockSourceState = { preference: null, authorization: null, sourceGeneration: null, failure: null };
  private checkSession: (() => void) | null = null;

  constructor(private readonly api: SharedUnlockApi, private readonly now: () => number = Date.now) {}

  reset(): void {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.pendingProof) wipe(this.pendingProof);
    this.pendingProof = null;
    this.checkSession = null;
    this.state = { preference: null, authorization: null, sourceGeneration: null, failure: null };
  }

  snapshot(): SharedUnlockSourceState {
    try {
      this.checkSession?.();
      const a = this.state.authorization;
      if (a && this.now() >= Math.min(a.idleDeadlineMs, a.absoluteDeadlineMs, a.offlineDeadlineMs)) this.reset();
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
    const timeout = setTimeout(() => { controller.abort(); wipe(context.authCredential); }, 10_000);
    const check = () => {
      if (version !== this.version || controller.signal.aborted) throw new SharedUnlockApiError("cancelled");
      context.assertCurrent();
      if (version !== this.version || controller.signal.aborted) throw new SharedUnlockApiError("cancelled");
    };
    try {
      check();
      const account = context.account;
      if (account.userId !== context.tokens.userId || !account.kdf) throw new SharedUnlockApiError("unauthorized");
      const bytes = await randomBytes(32);
      const generation = toBase64Url(bytes); wipe(bytes);
      check();
      const preference = await this.api.readPreference(context.tokens, controller.signal);
      check();
      this.state = { preference, authorization: null, sourceGeneration: null, failure: null };
      const authorization = await this.api.authorize(context.tokens, {
        authCredential: toBase64Url(context.authCredential), sourceGeneration: generation,
        expectedPreferenceRevision: preference.revision,
        expectedCredentialRevision: account.kdf.credentialRevision,
        expectedPrivateKeyWrapRevision: account.kdf.privateKeyWrapRevision,
        idleDeadlineMs: context.limits.idleDeadlineMs, absoluteDeadlineMs: context.limits.absoluteDeadlineMs,
        offlineDeadlineMs: context.limits.offlineDeadlineMs,
      }, controller.signal);
      check();
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
    }
  }
}
