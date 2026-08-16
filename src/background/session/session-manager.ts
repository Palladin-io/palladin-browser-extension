/**
 * The service worker's session brain: login, unlock, lock, logout, and the
 * auto-lock lifecycle — a session SEPARATE from the web panel's (plan §12.4).
 *
 * Key material lives only as `Uint8Array` buffers in this worker instance.
 * A service-worker restart loses the keys and returns the session to locked.
 * `lock` wipes the buffers; `logout` additionally clears tokens. The JWT can outlive the keys (auto-lock),
 * so `unlock` re-derives keys OFFLINE from the cached, non-secret account
 * material — no re-login, no network.
 *
 * Everything is dependency-injected (store, auth client, alarms, hooks, clock)
 * so the whole lifecycle is unit-testable against fakes.
 */

import { deriveKey, fromBase64, toBase64, wipe } from "@palladin/crypto";

import { AuthClient, isTotpRequired, type AuthResponse } from "./auth-client";
import {
  AutoLock,
  DEFAULT_AUTO_LOCK_POLICY,
  type AutoLockPolicy,
} from "./auto-lock";
import {
  NoopPushRegistration,
  NoopSyncTrigger,
  SessionHooks,
  type PushRegistration,
  type SyncTrigger,
} from "./hooks";
import { SessionStore } from "./session-store";
import { MasterPasswordUnlock, type UnlockSource } from "./unlock-source";
import {
  SessionError,
  type LoginResult,
  type SessionKeys,
  type SessionStatus,
  type SessionTokens,
} from "./types";

export interface SessionManagerDeps {
  store: SessionStore;
  authClient: AuthClient;
  autoLock: AutoLock;
  hooks?: SessionHooks;
  sync?: SyncTrigger;
  push?: PushRegistration;
  now?: () => number;
  createPasswordUnlock?: (password: string) => UnlockSource;
}

class SessionLifecycleChangedError extends Error {
  constructor() {
    super("Session lifecycle changed while unlocking");
    this.name = "SessionLifecycleChangedError";
  }
}

interface PendingTotpContext {
  readonly challengeToken: string;
  readonly apiUrl: string;
  readonly lifecycleGeneration: number;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly authClient: AuthClient;
  private readonly autoLock: AutoLock;
  private readonly now: () => number;
  private readonly createPasswordUnlock: (password: string) => UnlockSource;

  readonly hooks: SessionHooks;
  private readonly sync: SyncTrigger;
  private readonly push: PushRegistration;

  /** In-memory keys — the authoritative live copy while unlocked. */
  private keys: SessionKeys | null = null;
  private pendingTotp: PendingTotpContext | null = null;
  private lifecycleGeneration = 0;
  private lifecycleTerminations = 0;

  constructor(deps: SessionManagerDeps) {
    this.store = deps.store;
    this.authClient = deps.authClient;
    this.autoLock = deps.autoLock;
    this.hooks = deps.hooks ?? new SessionHooks();
    this.sync = deps.sync ?? new NoopSyncTrigger();
    this.push = deps.push ?? new NoopPushRegistration();
    this.now = deps.now ?? (() => Date.now());
    this.createPasswordUnlock = deps.createPasswordUnlock
      ?? ((password) => new MasterPasswordUnlock(password));
  }

  /**
   * Initialize after a service-worker restart. Keys are intentionally not
   * recoverable from storage, so a token-bearing session comes back locked.
   */
  async initialize(): Promise<SessionStatus> {
    // Chrome alarms outlive an MV3 worker instance. Since the corresponding
    // in-memory keys do not, discard the previous worker's stale deadline.
    this.autoLock.disarm();
    return this.getStatus();
  }

  async getStatus(): Promise<SessionStatus> {
    if (this.keys) return "unlocked";
    const tokens = await this.getBoundTokens();
    return tokens ? "locked" : "signed-out";
  }

  /** Live keys for in-worker consumers (fill engine, later). Null when locked. */
  getKeys(): SessionKeys | null {
    return this.keys;
  }

  /**
   * Current access token for in-worker REST consumers (the vault data layer), or
   * null when signed out. Read straight from the store so it always reflects the
   * latest rotation.
   */
  async getAccessToken(): Promise<string | null> {
    const tokens = await this.getBoundTokens();
    return tokens?.accessToken ?? null;
  }

  /** Stable cache partition for the authenticated account; never a key or token. */
  async getUserId(): Promise<string | null> {
    const tokens = await this.getBoundTokens();
    return tokens?.userId ?? null;
  }

  /**
   * Rotate the access token via the refresh token and persist the new pair.
   * Returns the fresh access token, or null when there is no session or the
   * refresh is rejected (the caller then treats the request as unauthenticated).
   */
  async refreshAccessToken(): Promise<string | null> {
    const tokens = await this.getBoundTokens();
    if (!tokens) return null;
    try {
      const auth = await this.authClient.refresh(tokens.refreshToken, tokens.apiUrl);
      this.assertApiUrl(tokens.apiUrl);
      await this.store.setTokens({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        userId: auth.userId,
        apiUrl: tokens.apiUrl,
      });
      return auth.accessToken;
    } catch {
      if (tokens.apiUrl !== this.authClient.currentApiUrl()) await this.store.clearAll();
      return null;
    }
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  /**
   * Start email+password login: fetch authSalt, prove the password with the
   * double-Argon2id authHash, and either finish (derive keys, unlock) or surface
   * a TOTP challenge. The password stays on the client; only `authHash` is sent.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    this.pendingTotp = null;
    const generation = this.captureLifecycleGeneration();
    const apiUrl = this.authClient.currentApiUrl();
    const { authSalt } = await this.authClient.fetchLoginSalt(email, apiUrl);
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    const authHash = await this.deriveAuthHash(password, authSalt);
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    const response = await this.authClient.login(email, authHash, apiUrl);
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    if (isTotpRequired(response)) {
      this.pendingTotp = {
        challengeToken: response.challengeToken,
        apiUrl,
        lifecycleGeneration: generation,
      };
      return { status: "totp-required", challengeToken: response.challengeToken };
    }
    await this.establishSession(response, password, generation, apiUrl);
    return { status: "unlocked" };
  }

  /** Second factor: exchange the TOTP/recovery code, then establish the session. */
  async completeTotp(
    challengeToken: string,
    code: string,
    password: string,
  ): Promise<void> {
    const pending = this.pendingTotp;
    const generation = this.captureLifecycleGeneration();
    if (
      pending === null
      || pending.challengeToken !== challengeToken
      || pending.lifecycleGeneration !== generation
      || pending.apiUrl !== this.authClient.currentApiUrl()
    ) {
      this.pendingTotp = null;
      throw new SessionError("network", "TOTP challenge is no longer valid");
    }
    const response = await this.authClient.totpLogin(
      challengeToken,
      code.trim(),
      pending.apiUrl,
    );
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(pending.apiUrl);
    this.pendingTotp = null;
    await this.establishSession(response, password, generation, pending.apiUrl);
  }

  cancelTotp(): void {
    this.pendingTotp = null;
  }

  private async deriveAuthHash(password: string, authSalt: string): Promise<string> {
    // authHash = base64(Argon2id(password, authSalt)); wiped right after send.
    const hash = await deriveKey(password, fromBase64(authSalt));
    try {
      return toBase64(hash);
    } finally {
      wipe(hash);
    }
  }

  private async establishSession(
    auth: AuthResponse,
    password: string,
    generation: number,
    apiUrl: string,
  ): Promise<void> {
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    const tokens: SessionTokens = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      userId: auth.userId,
      apiUrl,
    };
    await this.store.setTokens(tokens);
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);

    const account = await this.authClient.getAccount(auth.accessToken, apiUrl);
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    if (!account.salt || !account.encryptedPrivateKey) {
      // A password account always has this material; its absence means the
      // account isn't set up to unlock. Leave tokens, stay locked, signal why.
      throw new SessionError(
        "no-account-material",
        "Account has no key material to unlock",
      );
    }
    const material = {
      salt: account.salt,
      encryptedPrivateKey: account.encryptedPrivateKey,
    };
    await this.store.setMaterial(material);
    this.assertLifecycleGeneration(generation);

    const keys = await this.createPasswordUnlock(password).deriveKeys(material);
    await this.setUnlocked(keys, tokens.userId, generation);
  }

  // ─── Unlock (session locked, JWT may still be alive) ────────────────────────

  /** Re-derive keys for a locked session from cached material, via any source. */
  async unlock(source: UnlockSource): Promise<void> {
    const generation = this.captureLifecycleGeneration();
    const material = await this.store.getMaterial();
    this.assertLifecycleGeneration(generation);
    if (!material) {
      throw new SessionError("no-account-material", "No cached material to unlock");
    }
    const tokens = await this.getBoundTokens();
    this.assertLifecycleGeneration(generation);
    if (!tokens) {
      throw new SessionError("not-authenticated", "Cannot unlock without a session");
    }
    const keys = await source.deriveKeys(material);
    await this.setUnlocked(keys, tokens.userId, generation);
  }

  /** Convenience for the default master-password source. */
  unlockWithPassword(password: string): Promise<void> {
    return this.unlock(this.createPasswordUnlock(password));
  }

  private async setUnlocked(
    keys: SessionKeys,
    userId: string,
    generation: number,
  ): Promise<void> {
    let published = false;
    try {
      this.assertLifecycleGeneration(generation);
      const record = await this.store.getAutoLock();
      this.assertLifecycleGeneration(generation);
      const policy = record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
      const unlockedAt = this.now();
      await this.store.setAutoLock({ policy, lastActivityAt: unlockedAt });
      this.assertLifecycleGeneration(generation);

      this.wipeKeys();
      this.keys = keys;
      published = true;
      this.autoLock.arm(policy, unlockedAt);
      this.hooks.emitUnlocked({ userId });
      if (generation !== this.lifecycleGeneration) return;
      this.sync.requestSync("unlocked");
      if (generation !== this.lifecycleGeneration) return;
      void this.push.register(userId);
    } finally {
      if (!published) this.wipeSessionKeys(keys);
    }
  }

  // ─── Lock / logout ──────────────────────────────────────────────────────────

  /** Wipe key material and stop the idle timer; tokens + material survive. */
  async lock(): Promise<void> {
    this.beginLifecycleTermination();
    try {
      const wasUnlocked = this.keys !== null;
      this.wipeKeys();
      this.autoLock.disarm();
      if (!wasUnlocked) return;
      const tokens = await this.getBoundTokens();
      if (tokens) this.hooks.emitLocked({ userId: tokens.userId });
    } finally {
      this.endLifecycleTermination();
    }
  }

  /** Lock, revoke the refresh token server-side, and clear ALL session state. */
  async logout(): Promise<void> {
    this.beginLifecycleTermination();
    try {
      this.wipeKeys();
      this.autoLock.disarm();
      const tokens = await this.getBoundTokens();
      if (tokens) {
        await this.authClient.logout(tokens.refreshToken, tokens.apiUrl);
        void this.push.unregister(tokens.userId);
      }
      await this.store.clearAll();
      if (tokens) this.hooks.emitLocked({ userId: tokens.userId });
    } finally {
      this.endLifecycleTermination();
    }
  }

  private wipeKeys(): void {
    if (!this.keys) return;
    this.wipeSessionKeys(this.keys);
    this.keys = null;
  }

  private wipeSessionKeys(keys: SessionKeys): void {
    wipe(keys.masterKey);
    wipe(keys.privateKey);
  }

  private async getBoundTokens(): Promise<SessionTokens | null> {
    const tokens = await this.store.getTokens();
    if (!tokens) return null;
    if (tokens.apiUrl === this.authClient.currentApiUrl()) return tokens;
    await this.store.clearAll();
    return null;
  }

  private beginLifecycleTermination(): void {
    this.pendingTotp = null;
    this.lifecycleTerminations += 1;
    this.lifecycleGeneration += 1;
  }

  private endLifecycleTermination(): void {
    this.lifecycleTerminations -= 1;
  }

  private captureLifecycleGeneration(): number {
    this.assertLifecycleGeneration(this.lifecycleGeneration);
    return this.lifecycleGeneration;
  }

  private assertLifecycleGeneration(generation: number): void {
    if (
      this.lifecycleTerminations > 0
      || generation !== this.lifecycleGeneration
    ) {
      throw new SessionLifecycleChangedError();
    }
  }

  private assertApiUrl(apiUrl: string): void {
    if (apiUrl !== this.authClient.currentApiUrl()) {
      throw new SessionLifecycleChangedError();
    }
  }

  // ─── Auto-lock ────────────────────────────────────────────────────────────

  /** Record user activity and push the idle deadline out (no-op while locked). */
  async touchActivity(): Promise<void> {
    if (!this.keys) return;
    const record = await this.store.getAutoLock();
    const policy = record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
    const at = this.now();
    await this.store.setAutoLock({ policy, lastActivityAt: at });
    this.autoLock.arm(policy, at);
  }

  async getAutoLockPolicy(): Promise<AutoLockPolicy> {
    const record = await this.store.getAutoLock();
    return record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
  }

  /** Change the idle policy (settings UI is CVT-370); re-arms immediately. */
  async setAutoLockPolicy(policy: AutoLockPolicy): Promise<void> {
    const at = this.now();
    await this.store.setAutoLock({ policy, lastActivityAt: at });
    if (this.keys) this.autoLock.arm(policy, at);
  }
}
