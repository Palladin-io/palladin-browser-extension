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
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly authClient: AuthClient;
  private readonly autoLock: AutoLock;
  private readonly now: () => number;

  readonly hooks: SessionHooks;
  private readonly sync: SyncTrigger;
  private readonly push: PushRegistration;

  /** In-memory keys — the authoritative live copy while unlocked. */
  private keys: SessionKeys | null = null;

  constructor(deps: SessionManagerDeps) {
    this.store = deps.store;
    this.authClient = deps.authClient;
    this.autoLock = deps.autoLock;
    this.hooks = deps.hooks ?? new SessionHooks();
    this.sync = deps.sync ?? new NoopSyncTrigger();
    this.push = deps.push ?? new NoopPushRegistration();
    this.now = deps.now ?? (() => Date.now());
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
    const tokens = await this.store.getTokens();
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
    const tokens = await this.store.getTokens();
    return tokens?.accessToken ?? null;
  }

  /** Stable cache partition for the authenticated account; never a key or token. */
  async getUserId(): Promise<string | null> {
    const tokens = await this.store.getTokens();
    return tokens?.userId ?? null;
  }

  /**
   * Rotate the access token via the refresh token and persist the new pair.
   * Returns the fresh access token, or null when there is no session or the
   * refresh is rejected (the caller then treats the request as unauthenticated).
   */
  async refreshAccessToken(): Promise<string | null> {
    const tokens = await this.store.getTokens();
    if (!tokens) return null;
    try {
      const auth = await this.authClient.refresh(tokens.refreshToken);
      await this.store.setTokens({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        userId: auth.userId,
      });
      return auth.accessToken;
    } catch {
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
    const { authSalt } = await this.authClient.fetchLoginSalt(email);
    const authHash = await this.deriveAuthHash(password, authSalt);
    const response = await this.authClient.login(email, authHash);
    if (isTotpRequired(response)) {
      return { status: "totp-required", challengeToken: response.challengeToken };
    }
    await this.establishSession(response, password);
    return { status: "unlocked" };
  }

  /** Second factor: exchange the TOTP/recovery code, then establish the session. */
  async completeTotp(
    challengeToken: string,
    code: string,
    password: string,
  ): Promise<void> {
    const response = await this.authClient.totpLogin(challengeToken, code.trim());
    await this.establishSession(response, password);
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

  private async establishSession(auth: AuthResponse, password: string): Promise<void> {
    const tokens: SessionTokens = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      userId: auth.userId,
    };
    await this.store.setTokens(tokens);

    const account = await this.authClient.getAccount(auth.accessToken);
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

    const keys = await new MasterPasswordUnlock(password).deriveKeys(material);
    await this.setUnlocked(keys, tokens.userId);
  }

  // ─── Unlock (session locked, JWT may still be alive) ────────────────────────

  /** Re-derive keys for a locked session from cached material, via any source. */
  async unlock(source: UnlockSource): Promise<void> {
    const material = await this.store.getMaterial();
    if (!material) {
      throw new SessionError("no-account-material", "No cached material to unlock");
    }
    const tokens = await this.store.getTokens();
    if (!tokens) {
      throw new SessionError("not-authenticated", "Cannot unlock without a session");
    }
    const keys = await source.deriveKeys(material);
    await this.setUnlocked(keys, tokens.userId);
  }

  /** Convenience for the default master-password source. */
  unlockWithPassword(password: string): Promise<void> {
    return this.unlock(new MasterPasswordUnlock(password));
  }

  private async setUnlocked(keys: SessionKeys, userId: string): Promise<void> {
    this.wipeKeys();
    this.keys = keys;
    const record = await this.store.getAutoLock();
    const policy = record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
    await this.store.setAutoLock({ policy, lastActivityAt: this.now() });
    this.autoLock.arm(policy, this.now());

    this.hooks.emitUnlocked({ userId });
    this.sync.requestSync("unlocked");
    void this.push.register(userId);
  }

  // ─── Lock / logout ──────────────────────────────────────────────────────────

  /** Wipe key material and stop the idle timer; tokens + material survive. */
  async lock(): Promise<void> {
    if (!this.keys) return;
    const tokens = await this.store.getTokens();
    this.wipeKeys();
    this.autoLock.disarm();
    if (tokens) this.hooks.emitLocked({ userId: tokens.userId });
  }

  /** Lock, revoke the refresh token server-side, and clear ALL session state. */
  async logout(): Promise<void> {
    const tokens = await this.store.getTokens();
    this.wipeKeys();
    if (tokens) {
      await this.authClient.logout(tokens.refreshToken);
      void this.push.unregister(tokens.userId);
    }
    this.autoLock.disarm();
    await this.store.clearAll();
    if (tokens) this.hooks.emitLocked({ userId: tokens.userId });
  }

  private wipeKeys(): void {
    if (!this.keys) return;
    wipe(this.keys.masterKey);
    wipe(this.keys.privateKey);
    this.keys = null;
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
