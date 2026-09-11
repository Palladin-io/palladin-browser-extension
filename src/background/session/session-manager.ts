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

import type { SharedUnlockSourceSession } from "./shared-unlock-source";
import {
  assertIdentityKdfProfile,
  type BrowserSessionEnvelope,
  type BrowserSessionEnvelopeContext,
  decryptWithKey,
  deriveIdentityV1,
  fromBase64Url,
  IDENTITY_KDF_PROFILE_ID,
  IDENTITY_SECURITY_VERSION,
  openBrowserSessionEnvelope,
  sealBrowserSessionEnvelope,
  toBase64Url,
  wipe,
} from "@palladin/crypto";

import {
  AuthClient,
  isTotpRequired,
  type AccountResponse,
  type AuthResponse,
  type LoginKdfBootstrap,
} from "./auth-client";
import {
  AutoLock,
  DEFAULT_AUTO_LOCK_POLICY,
  policyIdleMs,
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
import type { PrepareManualUnlock, PreparedManualUnlock } from "./manual-unlock";
import { unlockDeadline, type SessionUnlockLimits, type SharedUnlockInstaller } from "./shared-unlock-install";
import { MasterPasswordUnlock, type UnlockSource } from "./unlock-source";
import {
  SessionError,
  type AccountMaterial,
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
  pendingTotpTimers?: {
    schedule(callback: () => void, delayMs: number): unknown;
    cancel(handle: unknown): void;
  };
  /** Browser-owned stable extension ID. Updates keep it; a different client fails closed. */
  clientId?: string;
  /** Absolute durable-session lifetime. Mirrors the backend refresh-session lifetime. */
  durableSessionTtlMs?: number;
  /** Optional sharing preparation never prevents the client's own manual unlock. */
  prepareManualUnlock?: PrepareManualUnlock;
  /** Explicit popup action only; expiry/security cleanup never invokes this. */
  recordManualClosing?: (accountId: string, action: "lock" | "logout") => Promise<void>;
  retireSharedUnlock?: (scope: Pick<SessionTokens, "userId" | "apiUrl">) => void;
  deliverManualClosing?: (session: SessionTokens, assertCurrent: () => void) => Promise<void>;
}

export const PENDING_TOTP_TTL_MS = 5 * 60 * 1_000;
export const DURABLE_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

interface ActiveDurableSessionPayload extends SessionTokens {
  readonly state: "active";
}

interface RefreshPendingDurableSessionPayload {
  readonly state: "refresh-pending";
}

type DurableSessionPayload =
  | ActiveDurableSessionPayload
  | RefreshPendingDurableSessionPayload;

const MAX_ACCESS_TOKEN_CHARS = 32_768;
const MAX_REFRESH_TOKEN_CHARS = 8_192;

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
  readonly bootstrap: LoginKdfBootstrap & { readonly accountId: string };
  readonly masterKey: Uint8Array;
  readonly authCredential: Uint8Array;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly authClient: AuthClient;
  private readonly autoLock: AutoLock;
  private readonly now: () => number;
  private readonly createPasswordUnlock: (password: string) => UnlockSource;
  private readonly pendingTotpTimers: NonNullable<SessionManagerDeps["pendingTotpTimers"]>;
  private readonly clientId: string;
  private readonly durableSessionTtlMs: number;
  private readonly prepareManualUnlock: PrepareManualUnlock | undefined;
  private readonly recordManualClosing: SessionManagerDeps["recordManualClosing"];
  private readonly retireSharedUnlock: SessionManagerDeps["retireSharedUnlock"];
  private readonly deliverManualClosing: SessionManagerDeps["deliverManualClosing"];

  readonly hooks: SessionHooks;
  private readonly sync: SyncTrigger;
  private readonly push: PushRegistration;

  /** In-memory keys — the authoritative live copy while unlocked. */
  private keys: SessionKeys | null = null;
  private keyScope: Pick<SessionTokens, "userId" | "apiUrl"> | null = null;
  private tokens: SessionTokens | null = null;
  private pendingTotp: PendingTotpContext | null = null;
  private pendingTotpTimer: unknown | null = null;
  private lifecycleGeneration = 0;
  private lifecycleTerminations = 0;
  private readonly inFlightKeyMaterial = new Set<Uint8Array>();
  private durableMutationTail: Promise<void> = Promise.resolve();
  private refreshInFlight: Promise<string | null> | null = null;
  private loginInFlight = false;
  private unlocksInFlight = 0;
  private sharedUnlockAttempt = 0;
  private sharedUnlockReceiverAbort: AbortController | null = null;
  private readonly sharedUnlockSourceAborts = new Set<AbortController>();
  private sharedUnlockLimits: SessionUnlockLimits | null = null;
  private sharedUnlockLocalDeadline = Infinity;
  private sessionClearGeneration = 0;

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
    this.clientId = deps.clientId ?? "palladin-browser-extension-test-client";
    this.durableSessionTtlMs = deps.durableSessionTtlMs ?? DURABLE_SESSION_TTL_MS;
    this.prepareManualUnlock = deps.prepareManualUnlock;
    this.recordManualClosing = deps.recordManualClosing;
    this.retireSharedUnlock = deps.retireSharedUnlock;
    this.deliverManualClosing = deps.deliverManualClosing;
    if (
      !Number.isSafeInteger(this.durableSessionTtlMs)
      || this.durableSessionTtlMs <= 0
    ) {
      throw new TypeError("Durable session TTL must be a positive safe integer");
    }
    this.pendingTotpTimers = deps.pendingTotpTimers ?? {
      schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /**
   * Initialize after a service-worker restart. Keys are intentionally not
   * recoverable from storage, so a token-bearing session comes back locked.
   */
  async initialize(): Promise<SessionStatus> {
    // Chrome alarms outlive an MV3 worker instance. Since the corresponding
    // in-memory keys do not, discard the previous worker's stale deadline.
    this.autoLock.disarm();
    await this.store.clearLegacyPlaintext();
    return this.getStatus();
  }

  async getStatus(): Promise<SessionStatus> {
    if (this.getKeys()) return "unlocked";
    if (await this.getBoundMemoryTokens()) return "locked";
    return await this.getBoundEnvelope() ? "locked" : "signed-out";
  }

  /** Live keys for in-worker consumers (fill engine, later). Null when locked. */
  getKeys(): SessionKeys | null {
    // Browser alarms can be delayed by suspension. Enforce the inherited
    // deadline synchronously at the key-use boundary as well.
    if (this.sharedUnlockLimits && this.now() >= Math.min(unlockDeadline(this.sharedUnlockLimits), this.sharedUnlockLocalDeadline)) {
      void this.lock();
    }
    return this.keys;
  }

  /** Snapshot for an in-worker coordinator; contains no key or token. */
  getSharedUnlockLimits(): SessionUnlockLimits | null {
    return this.getKeys() && this.sharedUnlockLimits ? {
      ...this.sharedUnlockLimits,
      idleDeadlineMs: Math.min(this.sharedUnlockLimits.idleDeadlineMs, this.sharedUnlockLocalDeadline),
    } : null;
  }

  /** Capture own authority before producing a source offer. No storage read,
   * activity update, token refresh or peer-selected session is allowed here. */
  captureSharedUnlockSource(): SharedUnlockSourceSession {
    const generation = this.captureLifecycleGeneration();
    const attempt = this.sharedUnlockAttempt;
    const controller = new AbortController();
    let keys = this.getKeys();
    let tokens = this.tokens;
    const read = () => {
      this.assertLifecycleGeneration(generation);
      const limits = this.getSharedUnlockLimits();
      if (controller.signal.aborted || !keys || !tokens || !limits
        || this.keys !== keys || this.tokens !== tokens || this.refreshInFlight
        || this.loginInFlight || this.unlocksInFlight > 0 || this.pendingTotp
        || attempt !== this.sharedUnlockAttempt) throw new SessionLifecycleChangedError();
      this.assertApiUrl(tokens.apiUrl);
      return { keys, tokens, limits };
    };
    const dispose = () => {
      keys = null;
      tokens = null;
      this.sharedUnlockSourceAborts.delete(controller);
      controller.abort();
    };
    read();
    this.sharedUnlockSourceAborts.add(controller);
    controller.signal.addEventListener("abort", dispose, { once: true });
    return { signal: controller.signal, read, dispose };
  }

  private invalidateSharedUnlockSources(): void {
    const pending = [...this.sharedUnlockSourceAborts];
    this.sharedUnlockSourceAborts.clear();
    for (const controller of pending) controller.abort();
  }

  /**
   * Capture before the receiver sends any proof. The route fence must reject
   * navigation, OFF, disconnect and changed account/organization/generations.
   * A successful commit whose installation fails is revoked by the coordinator
   * through ordinary own-session logout, never a linked group logout.
   */
  async beginSharedUnlockInstall(
    accountId: string,
    apiUrl: string,
    assertRouteCurrent: () => void,
  ): Promise<SharedUnlockInstaller> {
    const generation = this.captureLifecycleGeneration();
    const clearGeneration = this.sessionClearGeneration;
    const attempt = ++this.sharedUnlockAttempt;
    this.invalidateSharedUnlockSources();
    this.sharedUnlockReceiverAbort?.abort();
    const receiverAbort = new AbortController();
    this.sharedUnlockReceiverAbort = receiverAbort;
    let cancelled = false;
    let consumed = false;
    let completed = false;
    let pendingKeys: SessionKeys | null = null;
    const checkLocal = () => {
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      if (cancelled || receiverAbort.signal.aborted || attempt !== this.sharedUnlockAttempt || this.loginInFlight || this.unlocksInFlight > 0 || this.pendingTotp || this.keys) {
        throw new SessionLifecycleChangedError();
      }
    };
    const assertCurrent = () => {
      checkLocal();
      assertRouteCurrent();
      checkLocal();
    };
    try {
      assertCurrent();
      const existingAccountId = await this.getUserId();
      assertCurrent();
      if (existingAccountId && existingAccountId !== accountId) throw new SessionLifecycleChangedError();
      const previousEnvelope = await this.getBoundEnvelope();
      assertCurrent();
      return {
        get completed() { return completed; },
        signal: receiverAbort.signal,
        assertCurrent,
        cancel: () => {
          if (completed) return;
          cancelled = true;
          if (this.sharedUnlockReceiverAbort === receiverAbort) this.sharedUnlockReceiverAbort = null;
          receiverAbort.abort();
          if (pendingKeys) this.wipeSessionKeys(pendingKeys);
        },
        install: async ({ tokens, material, keys, limits, checkpoint }) => {
          // Ownership already moved to the live session. A duplicate cannot wipe
          // its buffers (nor use them to replace or renew that session).
          if (consumed && [this.keys, pendingKeys].some(owned => owned
            && (owned.masterKey === keys.masterKey || owned.privateKey === keys.privateKey))) {
            throw new SessionLifecycleChangedError();
          }
          let envelope: BrowserSessionEnvelope | null = null;
          let published = false;
          // Own the buffers immediately, including a duplicate install call.
          this.trackSessionKeys(keys);
          try {
            if (consumed) throw new SessionLifecycleChangedError();
            consumed = true;
            pendingKeys = keys;
            assertCurrent();
            if (tokens.userId !== accountId || material.accountId !== accountId || tokens.apiUrl !== apiUrl) {
              throw new SessionLifecycleChangedError();
            }
            const inherited = { ...limits };
            const assertInstallCurrent = () => {
              assertCurrent();
              if (this.now() >= unlockDeadline(inherited)) throw new SessionLifecycleChangedError();
            };
            assertInstallCurrent();
            const issuedAt = this.now();
            envelope = await this.sealDurablePayload({ state: "active", ...tokens }, keys.masterKey, {
              apiUrl, accountId, clientId: this.clientId,
              identitySecurityVersion: material.kdf.securityVersion,
              minimumIdentitySecurityVersion: material.kdf.minimumSecurityVersion,
              kdfProfileId: material.kdf.profileId, kdfSalt: material.kdf.kdfSalt,
              encryptedPrivateKey: material.encryptedPrivateKey,
              issuedAt, expiresAt: issuedAt + this.durableSessionTtlMs,
            });
            assertInstallCurrent();
            await this.runDurableMutation(async () => {
              assertInstallCurrent();
              await this.store.setSealedSession(envelope!);
              assertInstallCurrent();
            });
            assertInstallCurrent();
            await this.setUnlocked(keys, accountId, generation, inherited, assertInstallCurrent, tokens, checkpoint);
            assertRouteCurrent();
            if (cancelled || attempt !== this.sharedUnlockAttempt || this.now() >= unlockDeadline(inherited)) {
              throw new SessionLifecycleChangedError();
            }
            published = this.keys === keys && this.isLifecycleCurrent(generation);
            if (!published) throw new SessionLifecycleChangedError();
            completed = true;
            if (this.sharedUnlockReceiverAbort === receiverAbort) this.sharedUnlockReceiverAbort = null;
          } finally {
            if (pendingKeys === keys) pendingKeys = null;
            this.untrackSessionKeys(keys);
            if (!published) {
              if (this.keys === keys) {
                this.wipeKeys();
                this.tokens = null;
                this.autoLock.disarm();
                // Notify surfaces even if an unlocked listener threw. Cleanup
                // must finish regardless of another subscriber's exception.
                try { this.hooks.emitLocked({ userId: accountId }); } catch { /* keys already erased */ }
              }
              this.wipeSessionKeys(keys);
              if (envelope) {
                const written = envelope;
                await this.runDurableMutation(async () => {
                  const current = await this.store.getSealedSession();
                  if (current?.encodedSuitePayload !== written.encodedSuitePayload) return;
                  if (previousEnvelope && clearGeneration === this.sessionClearGeneration
                    && apiUrl === this.authClient.currentApiUrl()) await this.store.setSealedSession(previousEnvelope);
                  else await this.store.clearSealedSession();
                });
              }
            }
          }
        },
      };
    } catch (error) {
      if (this.sharedUnlockReceiverAbort === receiverAbort) this.sharedUnlockReceiverAbort = null;
      receiverAbort.abort();
      throw error;
    }
  }

  /**
   * Current access token for in-worker REST consumers (the vault data layer), or
   * null when signed out. Read straight from the store so it always reflects the
   * latest rotation.
   */
  async getAccessToken(): Promise<string | null> {
    const tokens = await this.getBoundMemoryTokens();
    return tokens?.accessToken ?? null;
  }

  /** Stable cache partition for the authenticated account; never a key or token. */
  async getUserId(): Promise<string | null> {
    const tokens = await this.getBoundMemoryTokens();
    if (tokens) return tokens.userId;
    return (await this.getBoundEnvelope())?.context.accountId ?? null;
  }

  /**
   * Rotate the access token via the refresh token and persist the new pair.
   * Returns the fresh access token, or null when there is no session or the
   * refresh is rejected (the caller then treats the request as unauthenticated).
   * Transient transport or throttling failures preserve the bound session and
   * are rethrown.
   */
  refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.invalidateSharedUnlockSources();
    const operation = this.rotateAccessToken().finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = null;
    });
    this.refreshInFlight = operation;
    return operation;
  }

  private async rotateAccessToken(): Promise<string | null> {
    const generation = this.captureLifecycleGeneration();
    const tokens = await this.getBoundMemoryTokens();
    const keys = this.keys;
    if (!tokens || !keys) return null;
    const envelope = await this.getBoundEnvelope();
    if (!envelope) return null;
    let pendingCommitted = false;
    let pendingEnvelope: BrowserSessionEnvelope | null = null;

    try {
      // Write a sealed pending marker before contacting the rotation endpoint.
      // If the worker dies after the server rotates but before the replacement
      // envelope commits, the next unlock sees the marker and requires re-login.
      const pending = await this.sealDurablePayload(
        { state: "refresh-pending" },
        keys.masterKey,
        envelope.context,
      );
      pendingEnvelope = pending;
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(tokens.apiUrl);
      await this.setSealedSessionForGeneration(pending, generation);
      pendingCommitted = true;
      this.tokens = null;

      const auth = await this.authClient.refresh(tokens.refreshToken, tokens.apiUrl);
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(tokens.apiUrl);
      const replacementTokens: SessionTokens = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        // Refresh rotates credentials for the already-bound session. The
        // backend intentionally returns no duplicate account identity.
        userId: tokens.userId,
        apiUrl: tokens.apiUrl,
      };
      const replacement = await this.sealDurablePayload(
        { state: "active", ...replacementTokens },
        keys.masterKey,
        envelope.context,
      );
      await this.setSealedSessionForGeneration(replacement, generation);
      this.assertApiUrl(tokens.apiUrl);
      this.tokens = replacementTokens;
      return auth.accessToken;
    } catch (error) {
      if (!this.isLifecycleCurrent(generation)) return null;
      if (!pendingCommitted) {
        if (pendingEnvelope) {
          await this.restoreSealedSessionIfMatches(
            pendingEnvelope,
            envelope,
            generation,
          );
        }
        throw error;
      }
      if (
        error instanceof SessionError
        && (error.code === "network" || error.code === "rate-limited")
        && pendingEnvelope
      ) {
        let restored = false;
        try {
          restored = await this.restoreSealedSessionIfMatches(
            pendingEnvelope,
            envelope,
            generation,
          );
        } catch {
          // Fall through to the fail-closed cleanup when durable recovery fails.
        }
        if (!this.isLifecycleCurrent(generation)) return null;
        if (restored) {
          this.tokens = tokens;
          throw error;
        }
      }
      // A pending marker means the durable session cannot be proven current.
      // Clear it before returning so neither old nor unpersisted rotated tokens
      // can be presented as a restorable session.
      this.beginLifecycleTermination();
      try {
        this.wipeKeys();
        this.autoLock.disarm();
        this.tokens = null;
        await this.runDurableMutation(() => this.store.clearAll());
        this.hooks.emitLocked({ userId: tokens.userId });
      } finally {
        this.endLifecycleTermination();
      }
      return null;
    }
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  /**
   * Start email+password login through the canonical Identity KDF and either
   * finish or retain only the derived MK for a host-bound TOTP challenge. The
   * password stays on the client; only `authCredential` is sent.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    if (this.loginInFlight) {
      throw new SessionError("network", "Another sign-in attempt is already in progress");
    }
    this.sharedUnlockAttempt += 1;
    this.invalidateSharedUnlockSources();
    this.sharedUnlockReceiverAbort?.abort();
    this.sharedUnlockReceiverAbort = null;
    this.loginInFlight = true;
    try {
      return await this.performLogin(email, password);
    } finally {
      this.loginInFlight = false;
    }
  }

  private async performLogin(email: string, password: string): Promise<LoginResult> {
    this.clearPendingTotp();
    const generation = this.captureLifecycleGeneration();
    const apiUrl = this.authClient.currentApiUrl();
    const bootstrap = await this.authClient.fetchLoginKdf(
      email,
      IDENTITY_KDF_PROFILE_ID,
      apiUrl,
    );
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(apiUrl);
    this.assertLoginBootstrap(bootstrap);
    const salt = fromBase64Url(bootstrap.kdfSalt, 16);
    const identity = await deriveIdentityV1(password, bootstrap.accountId, salt);
    this.trackInFlightKeyMaterial(identity.masterKey);
    this.trackInFlightKeyMaterial(identity.authCredential);
    let transferredMasterKey = false;
    try {
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      const response = await this.authClient.login({
        email,
        securityVersion: IDENTITY_SECURITY_VERSION,
        kdfProfileId: IDENTITY_KDF_PROFILE_ID,
        authCredential: toBase64Url(identity.authCredential),
      }, apiUrl);
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      if (isTotpRequired(response)) {
        const pending: PendingTotpContext = {
          challengeToken: response.challengeToken,
          apiUrl,
          lifecycleGeneration: generation,
          bootstrap,
          masterKey: identity.masterKey,
          authCredential: identity.authCredential.slice(),
        };
        this.pendingTotp = pending;
        try {
          this.pendingTotpTimer = this.pendingTotpTimers.schedule(() => {
            this.pendingTotpTimer = null;
            if (this.pendingTotp !== pending) return;
            wipe(pending.masterKey);
            wipe(pending.authCredential);
            this.pendingTotp = null;
          }, PENDING_TOTP_TTL_MS);
        } catch (error) {
          this.pendingTotp = null;
          wipe(pending.authCredential);
          throw error;
        }
        transferredMasterKey = true;
        return { status: "totp-required", challengeToken: response.challengeToken };
      }
      transferredMasterKey = true;
      await this.establishSession(
        response,
        identity.masterKey,
        bootstrap,
        generation,
        apiUrl,
        identity.authCredential,
      );
      return { status: "unlocked" };
    } finally {
      this.untrackInFlightKeyMaterial(identity.masterKey);
      this.untrackInFlightKeyMaterial(identity.authCredential);
      wipe(salt);
      wipe(identity.authCredential);
      if (!transferredMasterKey) wipe(identity.masterKey);
    }
  }

  /** Second factor: exchange the TOTP/recovery code, then establish the session. */
  async completeTotp(
    challengeToken: string,
    code: string,
  ): Promise<void> {
    const pending = this.pendingTotp;
    const generation = this.captureLifecycleGeneration();
    if (
      pending === null
      || pending.challengeToken !== challengeToken
      || pending.lifecycleGeneration !== generation
      || pending.apiUrl !== this.authClient.currentApiUrl()
    ) {
      this.clearPendingTotp();
      throw new SessionError("network", "TOTP challenge is no longer valid");
    }
    const response = await this.authClient.totpLogin(
      challengeToken,
      code.trim(),
      pending.apiUrl,
    );
    this.assertLifecycleGeneration(generation);
    this.assertApiUrl(pending.apiUrl);
    if (this.pendingTotp !== pending) {
      throw new SessionError("network", "TOTP challenge expired during verification");
    }
    this.pendingTotp = null;
    this.cancelPendingTotpTimer();
    try {
      await this.establishSession(response, pending.masterKey, pending.bootstrap,
        generation, pending.apiUrl, pending.authCredential);
    } finally {
      wipe(pending.authCredential);
    }
  }

  cancelTotp(): void {
    this.clearPendingTotp();
  }

  private assertLoginBootstrap(bootstrap: LoginKdfBootstrap): void {
    try {
      assertIdentityKdfProfile(bootstrap);
    } catch {
      throw new SessionError("unsupported-security", "Unsupported Identity KDF profile");
    }
  }

  private async establishSession(
    auth: AuthResponse,
    masterKey: Uint8Array,
    bootstrap: LoginKdfBootstrap & { readonly accountId: string },
    generation: number,
    apiUrl: string,
    authCredential: Uint8Array,
  ): Promise<void> {
    let handedToSession = false;
    let persistedEnvelope: BrowserSessionEnvelope | null = null;
    let privateKey: Uint8Array | null = null;
    let trackedPrivateKey: Uint8Array | null = null;
    this.trackInFlightKeyMaterial(masterKey);
    this.trackInFlightKeyMaterial(authCredential);
    let encryptedPrivateKey: Uint8Array | null = null;
    try {
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      const tokens: SessionTokens = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        userId: auth.userId,
        apiUrl,
      };

      const account = await this.authClient.getAccount(auth.accessToken, apiUrl);
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      if (!account.kdf || !account.encryptedPrivateKey) {
        // A password account always has this material; its absence means the
        // account isn't set up to unlock. Do not persist the new session.
        throw new SessionError(
          "no-account-material",
          "Account has no key material to unlock",
        );
      }
      this.assertAuthenticatedAccount(account, bootstrap, auth.userId);
      const material = {
        accountId: account.userId,
        kdf: {
          securityVersion: account.kdf.securityVersion,
          minimumSecurityVersion: account.kdf.minimumSecurityVersion,
          profileId: account.kdf.profileId,
          kdfSalt: account.kdf.kdfSalt,
        },
        encryptedPrivateKey: account.encryptedPrivateKey,
      };
      encryptedPrivateKey = fromBase64Url(account.encryptedPrivateKey, 4_096);
      try {
        privateKey = await decryptWithKey(encryptedPrivateKey, masterKey);
      } catch {
        throw new SessionError(
          "incorrect-password",
          "Account key material could not be opened",
        );
      }
      trackedPrivateKey = privateKey;
      this.trackInFlightKeyMaterial(privateKey);
      this.assertLifecycleGeneration(generation);

      const issuedAt = this.now();
      const context: BrowserSessionEnvelopeContext = {
        apiUrl,
        accountId: material.accountId,
        clientId: this.clientId,
        identitySecurityVersion: material.kdf.securityVersion,
        minimumIdentitySecurityVersion: material.kdf.minimumSecurityVersion,
        kdfProfileId: material.kdf.profileId,
        kdfSalt: material.kdf.kdfSalt,
        encryptedPrivateKey: material.encryptedPrivateKey,
        issuedAt,
        expiresAt: issuedAt + this.durableSessionTtlMs,
      };
      const envelope = await this.sealDurablePayload(
        { state: "active", ...tokens },
        masterKey,
        context,
      );
      persistedEnvelope = envelope;
      await this.setSealedSessionForGeneration(envelope, generation);
      this.assertApiUrl(apiUrl);

      const limits = await this.prepareOwnSharing(tokens, account, authCredential, envelope, generation);
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);

      const keys = { masterKey, privateKey };
      privateKey = null;
      handedToSession = true;
      this.tokens = tokens;
      await this.setUnlocked(keys, tokens.userId, generation, limits, undefined, undefined, limits?.checkpoint);
    } finally {
      this.untrackInFlightKeyMaterial(masterKey);
      this.untrackInFlightKeyMaterial(authCredential);
      if (trackedPrivateKey) this.untrackInFlightKeyMaterial(trackedPrivateKey);
      if (encryptedPrivateKey) wipe(encryptedPrivateKey);
      if (privateKey) wipe(privateKey);
      if (!handedToSession) wipe(masterKey);
      if (!handedToSession && persistedEnvelope) {
        await this.clearSealedSessionForGeneration(persistedEnvelope, generation);
      }
    }
  }

  private assertAuthenticatedAccount(
    account: AccountResponse,
    bootstrap: LoginKdfBootstrap & { readonly accountId: string },
    authenticatedUserId: string,
  ): void {
    if (
      !account.kdf
      || account.userId !== authenticatedUserId
      || account.userId !== bootstrap.accountId
      || account.kdf.securityVersion !== IDENTITY_SECURITY_VERSION
      || account.kdf.minimumSecurityVersion > IDENTITY_SECURITY_VERSION
      || account.kdf.profileId !== IDENTITY_KDF_PROFILE_ID
      || account.kdf.kdfSalt !== bootstrap.kdfSalt
    ) {
      throw new SessionError("unsupported-security", "Identity KDF state mismatch");
    }
    this.assertLoginBootstrap({ ...bootstrap, kdfSalt: account.kdf.kdfSalt });
  }

  // ─── Unlock (session locked, JWT may still be alive) ────────────────────────

  /** Re-derive keys for a locked session from cached material, via any source. */
  async unlock(source: UnlockSource): Promise<void> {
    this.sharedUnlockAttempt += 1;
    this.invalidateSharedUnlockSources();
    this.sharedUnlockReceiverAbort?.abort();
    this.sharedUnlockReceiverAbort = null;
    this.unlocksInFlight += 1;
    try {
      await this.performUnlock(source);
    } finally {
      this.unlocksInFlight -= 1;
    }
  }

  private async performUnlock(source: UnlockSource): Promise<void> {
    const generation = this.captureLifecycleGeneration();
    const envelope = await this.getBoundEnvelope();
    this.assertLifecycleGeneration(generation);
    if (!envelope) {
      throw new SessionError("no-account-material", "No cached material to unlock");
    }
    const material = this.materialFromEnvelope(envelope);
    let manualProof: Uint8Array | null = null;
    const keys = await source.deriveKeys(material, proof => {
      this.assertLifecycleGeneration(generation);
      if (manualProof) throw new SessionLifecycleChangedError();
      manualProof = proof.slice();
      this.trackInFlightKeyMaterial(manualProof);
    }).catch(error => {
      if (manualProof) { wipe(manualProof); this.untrackInFlightKeyMaterial(manualProof); }
      throw error;
    });
    this.trackSessionKeys(keys);
    try {
      try {
        this.assertLifecycleGeneration(generation);
      } catch (error) {
        this.wipeSessionKeys(keys);
        throw error;
      }
      let tokens = await this.getBoundMemoryTokens();
      if (!tokens) {
        try {
          const payload = await this.openDurablePayload(envelope, keys.masterKey);
          this.assertLifecycleGeneration(generation);
          if (payload.state !== "active") {
            throw new SessionError(
              "not-authenticated",
              "Stored session refresh did not complete",
            );
          }
          tokens = payload;
        } catch (error) {
          this.wipeSessionKeys(keys);
          // Derivation succeeded, so the password is correct. Any failure after
          // that point is authenticated-envelope tamper, an interrupted refresh,
          // or an obsolete protocol. Delete only the envelope observed by this
          // operation; a newer lifecycle owns any replacement.
          await this.clearSealedSessionForGeneration(envelope, generation);
          this.tokens = null;
          if (error instanceof SessionLifecycleChangedError) throw error;
          throw new SessionError("not-authenticated", "Stored session is invalid");
        }
      }
      try {
        this.assertLifecycleGeneration(generation);
        if (tokens.userId !== envelope.context.accountId || tokens.apiUrl !== envelope.context.apiUrl) {
          throw new SessionError("not-authenticated", "Stored session binding is invalid");
        }
        this.tokens = tokens;
        let limits: PreparedManualUnlock | null = null;
        if (manualProof && this.prepareManualUnlock) {
          try {
            const account = await this.authClient.getAccount(tokens.accessToken, tokens.apiUrl);
            this.assertLifecycleGeneration(generation);
            this.assertApiUrl(tokens.apiUrl);
            limits = await this.prepareOwnSharing(tokens, account, manualProof, envelope, generation);
          } catch {
            // Network/step-up failures stop sharing, not this own password unlock.
          }
        }
        this.assertLifecycleGeneration(generation);
        this.assertApiUrl(tokens.apiUrl);
        await this.setUnlocked(keys, tokens.userId, generation, limits, undefined, undefined, limits?.checkpoint);
      } catch (error) {
        if (this.keys !== keys) this.wipeSessionKeys(keys);
        throw error;
      }
    } finally {
      this.untrackSessionKeys(keys);
      if (manualProof) { wipe(manualProof); this.untrackInFlightKeyMaterial(manualProof); }
    }
  }

  private async prepareOwnSharing(tokens: SessionTokens, account: AccountResponse,
    authCredential: Uint8Array, envelope: BrowserSessionEnvelope, generation: number): Promise<PreparedManualUnlock | null> {
    if (!this.prepareManualUnlock) return null;
    const apiUrl = tokens.apiUrl;
    const attempt = this.sharedUnlockAttempt;
    const assertCurrent = () => {
      this.assertLifecycleGeneration(generation);
      this.assertApiUrl(apiUrl);
      if (attempt !== this.sharedUnlockAttempt) throw new SessionLifecycleChangedError();
    };
    try {
      assertCurrent();
      const policy = await this.getAutoLockPolicy();
      assertCurrent();
      const now = this.now(), idle = policyIdleMs(policy);
      // These are own Identity-session ceilings. Offline Vault access remains
      // independently bounded by each signed Vault lease; this grants none.
      const limits = { unlockedAtMs: now,
        idleDeadlineMs: Math.min(idle === null ? Infinity : now + idle, envelope.context.expiresAt),
        absoluteDeadlineMs: envelope.context.expiresAt, offlineDeadlineMs: envelope.context.expiresAt };
      const prepared = await this.prepareManualUnlock({ tokens, account, authCredential, limits, assertCurrent });
      assertCurrent();
      return prepared;
    } catch {
      return null;
    }
  }

  /** Convenience for the default master-password source. */
  unlockWithPassword(password: string): Promise<void> {
    return this.unlock(this.createPasswordUnlock(password));
  }

  private async setUnlocked(
    keys: SessionKeys,
    userId: string,
    generation: number,
    inherited: SessionUnlockLimits | null = null,
    assertCurrent?: () => void,
    ownTokens?: SessionTokens,
    checkpoint?: (effectiveDeadlineMs: number) => Promise<number>,
  ): Promise<void> {
    let published = false;
    try {
      this.assertLifecycleGeneration(generation);
      assertCurrent?.();
      const record = await this.store.getAutoLock();
      this.assertLifecycleGeneration(generation);
      assertCurrent?.();
      const policy = record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
      const unlockedAt = this.now();
      await this.store.setAutoLock({ policy, lastActivityAt: unlockedAt });
      this.assertLifecycleGeneration(generation);
      assertCurrent?.();

      const localIdle = policyIdleMs(policy);
      let localDeadline = localIdle === null ? Infinity : unlockedAt + localIdle;
      if (checkpoint && inherited) {
        localDeadline = Math.min(localDeadline, await checkpoint(Math.min(localDeadline, unlockDeadline(inherited))));
        this.assertLifecycleGeneration(generation);
        assertCurrent?.();
        if (this.now() >= Math.min(localDeadline, unlockDeadline(inherited))) throw new SessionLifecycleChangedError();
      }
      if (inherited && this.now() >= Math.min(localDeadline, unlockDeadline(inherited))) throw new SessionLifecycleChangedError();
      this.wipeKeys();
      this.sharedUnlockLimits = inherited ? {
        unlockedAtMs: inherited.unlockedAtMs, idleDeadlineMs: inherited.idleDeadlineMs,
        absoluteDeadlineMs: inherited.absoluteDeadlineMs, offlineDeadlineMs: inherited.offlineDeadlineMs,
      } : null;
      this.sharedUnlockLocalDeadline = localDeadline;
      if (ownTokens) this.tokens = ownTokens;
      this.keyScope = { userId, apiUrl: (ownTokens ?? this.tokens)?.apiUrl ?? this.authClient.currentApiUrl() };
      this.keys = keys;
      published = true;
      this.autoLock.arm(policy, unlockedAt, inherited ? Math.min(unlockDeadline(inherited), localDeadline) : undefined);
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

  /** Wipe key material and stop the idle timer; the sealed durable session survives. */
  async lock(reason?: "manual"): Promise<void> {
    if (this.keys && this.keyScope) {
      try { this.retireSharedUnlock?.({ ...this.keyScope }); }
      catch { /* Retirement observers cannot prevent key destruction. */ }
    }
    this.beginLifecycleTermination();
    const generation = this.lifecycleGeneration;
    try {
      const wasUnlocked = this.keys !== null;
      this.wipeKeys();
      this.autoLock.disarm();
      if (!wasUnlocked && reason !== "manual") return;
      const tokens = await this.getBoundMemoryTokens();
      const userId = tokens?.userId ?? (await this.getBoundEnvelope())?.context.accountId ?? null;
      // A refresh-pending envelope intentionally has no published tokens, but
      // surfaces must still observe the authoritative transition to locked.
      try {
        if (userId && reason === "manual") await this.recordManualClosing?.(userId, "lock");
        if (tokens && reason === "manual") await this.deliverClosing(tokens, generation);
      } finally {
        if (userId) this.hooks.emitLocked({ userId });
      }
    } finally {
      this.endLifecycleTermination();
    }
  }

  /** Lock, revoke the refresh token server-side, and clear ALL session state. */
  async logout(reason?: "manual"): Promise<void> {
    this.sessionClearGeneration += 1;
    this.beginLifecycleTermination();
    const generation = this.lifecycleGeneration;
    try {
      this.wipeKeys();
      this.autoLock.disarm();
      const tokens = await this.getBoundMemoryTokens();
      const durableUserId = tokens
        ? tokens.userId
        : (await this.getBoundEnvelope())?.context.accountId ?? null;
      if (reason === "manual") this.tokens = null;
      try {
        if (durableUserId && reason === "manual") await this.recordManualClosing?.(durableUserId, "logout");
        if (tokens && reason === "manual") await this.deliverClosing(tokens, generation);
      } finally {
        if (tokens) {
          // Remote revocation is best-effort and pinned to the issuing host. Do
          // not let an unavailable old/self-hosted server block the authoritative
          // local wipe or a subsequent server change.
          void this.authClient.logout(tokens.refreshToken, tokens.apiUrl);
          void this.push.unregister(tokens.userId);
        }
        await this.runDurableMutation(() => this.store.clearAll());
        this.tokens = null;
        if (durableUserId) this.hooks.emitLocked({ userId: durableUserId });
      }
    } finally {
      this.endLifecycleTermination();
    }
  }

  private async deliverClosing(tokens: SessionTokens, generation: number): Promise<void> {
    const check = () => {
      if (this.lifecycleGeneration !== generation) throw new SessionLifecycleChangedError();
      this.assertApiUrl(tokens.apiUrl);
    };
    check();
    await this.deliverManualClosing?.(tokens, check);
  }

  private wipeKeys(): void {
    this.keyScope = null;
    this.sharedUnlockLimits = null;
    this.sharedUnlockLocalDeadline = Infinity;
    if (!this.keys) return;
    this.wipeSessionKeys(this.keys);
    this.keys = null;
  }

  private wipeSessionKeys(keys: SessionKeys): void {
    wipe(keys.masterKey);
    wipe(keys.privateKey);
  }

  private async getBoundMemoryTokens(): Promise<SessionTokens | null> {
    const tokens = this.tokens;
    if (!tokens) return null;
    const envelope = await this.getBoundEnvelope();
    if (
      envelope
      && tokens.apiUrl === envelope.context.apiUrl
      && tokens.userId === envelope.context.accountId
    ) return tokens;
    this.tokens = null;
    return null;
  }

  private async getBoundEnvelope(): Promise<BrowserSessionEnvelope | null> {
    const envelope = await this.store.getSealedSession();
    if (!envelope) return null;
    const context = envelope.context;
    if (
      context.apiUrl !== this.authClient.currentApiUrl()
      || context.clientId !== this.clientId
      || context.identitySecurityVersion !== IDENTITY_SECURITY_VERSION
      || context.kdfProfileId !== IDENTITY_KDF_PROFILE_ID
      || context.expiresAt <= this.now()
    ) {
      await this.invalidateBoundSession(context.accountId);
      return null;
    }
    return envelope;
  }

  private async invalidateBoundSession(userId: string): Promise<void> {
    this.sessionClearGeneration += 1;
    this.beginLifecycleTermination();
    try {
      this.wipeKeys();
      this.autoLock.disarm();
      this.tokens = null;
      try {
        await this.runDurableMutation(() => this.store.clearAll());
      } finally {
        // A failed storage cleanup cannot leave another extension surface
        // displaying decrypted state after the session became invalid.
        this.hooks.emitLocked({ userId });
      }
    } finally {
      this.endLifecycleTermination();
    }
  }

  private materialFromEnvelope(envelope: BrowserSessionEnvelope): AccountMaterial {
    return {
      accountId: envelope.context.accountId,
      kdf: {
        securityVersion: envelope.context.identitySecurityVersion,
        minimumSecurityVersion: envelope.context.minimumIdentitySecurityVersion,
        profileId: envelope.context.kdfProfileId,
        kdfSalt: envelope.context.kdfSalt,
      },
      encryptedPrivateKey: envelope.context.encryptedPrivateKey,
    };
  }

  private async sealDurablePayload(
    payload: DurableSessionPayload,
    masterKey: Uint8Array,
    context: BrowserSessionEnvelopeContext,
  ): Promise<BrowserSessionEnvelope> {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    try {
      return await sealBrowserSessionEnvelope(bytes, masterKey, context);
    } finally {
      wipe(bytes);
    }
  }

  private async openDurablePayload(
    envelope: BrowserSessionEnvelope,
    masterKey: Uint8Array,
  ): Promise<DurableSessionPayload> {
    const bytes = await openBrowserSessionEnvelope(envelope, masterKey, { now: this.now });
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return this.parseDurablePayload(JSON.parse(decoded) as unknown, envelope.context);
    } finally {
      wipe(bytes);
    }
  }

  private parseDurablePayload(
    value: unknown,
    context: BrowserSessionEnvelopeContext,
  ): DurableSessionPayload {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Durable session payload must be an object");
    }
    const input = value as Record<string, unknown>;
    if (input["state"] === "refresh-pending") {
      if (Object.keys(input).length !== 1) {
        throw new TypeError("Refresh-pending payload has unexpected fields");
      }
      return { state: "refresh-pending" };
    }
    const expected = ["accessToken", "apiUrl", "refreshToken", "state", "userId"].sort();
    const actual = Object.keys(input).sort();
    if (
      input["state"] !== "active"
      || actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
    ) {
      throw new TypeError("Active durable session payload is invalid");
    }
    const accessToken = input["accessToken"];
    const refreshToken = input["refreshToken"];
    const userId = input["userId"];
    const apiUrl = input["apiUrl"];
    if (
      typeof accessToken !== "string"
      || accessToken.length === 0
      || accessToken.length > MAX_ACCESS_TOKEN_CHARS
      || typeof refreshToken !== "string"
      || refreshToken.length === 0
      || refreshToken.length > MAX_REFRESH_TOKEN_CHARS
      || userId !== context.accountId
      || apiUrl !== context.apiUrl
    ) {
      throw new TypeError("Durable session token binding is invalid");
    }
    return { state: "active", accessToken, refreshToken, userId, apiUrl };
  }

  private beginLifecycleTermination(): void {
    this.clearPendingTotp();
    this.lifecycleTerminations += 1;
    this.lifecycleGeneration += 1;
    this.invalidateSharedUnlockSources();
    this.sharedUnlockReceiverAbort?.abort();
    this.sharedUnlockReceiverAbort = null;
    this.wipeInFlightKeyMaterial();
  }

  private clearPendingTotp(): void {
    this.cancelPendingTotpTimer();
    if (this.pendingTotp) {
      wipe(this.pendingTotp.masterKey);
      wipe(this.pendingTotp.authCredential);
    }
    this.pendingTotp = null;
  }

  private cancelPendingTotpTimer(): void {
    if (this.pendingTotpTimer === null) return;
    this.pendingTotpTimers.cancel(this.pendingTotpTimer);
    this.pendingTotpTimer = null;
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

  private isLifecycleCurrent(generation: number): boolean {
    return this.lifecycleTerminations === 0 && generation === this.lifecycleGeneration;
  }

  private trackInFlightKeyMaterial(value: Uint8Array): void {
    this.inFlightKeyMaterial.add(value);
  }

  private untrackInFlightKeyMaterial(value: Uint8Array): void {
    this.inFlightKeyMaterial.delete(value);
  }

  private trackSessionKeys(keys: SessionKeys): void {
    this.trackInFlightKeyMaterial(keys.masterKey);
    this.trackInFlightKeyMaterial(keys.privateKey);
  }

  private untrackSessionKeys(keys: SessionKeys): void {
    this.untrackInFlightKeyMaterial(keys.masterKey);
    this.untrackInFlightKeyMaterial(keys.privateKey);
  }

  private wipeInFlightKeyMaterial(): void {
    for (const value of this.inFlightKeyMaterial) wipe(value);
    this.inFlightKeyMaterial.clear();
  }

  private async runDurableMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.durableMutationTail;
    let release!: () => void;
    this.durableMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private setSealedSessionForGeneration(
    envelope: BrowserSessionEnvelope,
    generation: number,
  ): Promise<void> {
    return this.runDurableMutation(async () => {
      this.assertLifecycleGeneration(generation);
      await this.store.setSealedSession(envelope);
      this.assertLifecycleGeneration(generation);
    });
  }

  private clearSealedSessionForGeneration(
    expected: BrowserSessionEnvelope,
    generation: number,
  ): Promise<void> {
    return this.runDurableMutation(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      const current = await this.store.getSealedSession();
      if (current?.encodedSuitePayload === expected.encodedSuitePayload) {
        await this.store.clearSealedSession();
      }
    });
  }

  private restoreSealedSessionIfMatches(
    expected: BrowserSessionEnvelope,
    replacement: BrowserSessionEnvelope,
    generation: number,
  ): Promise<boolean> {
    return this.runDurableMutation(async () => {
      this.assertLifecycleGeneration(generation);
      const current = await this.store.getSealedSession();
      if (current?.encodedSuitePayload === expected.encodedSuitePayload) {
        await this.store.setSealedSession(replacement);
        return true;
      }
      return false;
    });
  }

  private assertApiUrl(apiUrl: string): void {
    if (apiUrl !== this.authClient.currentApiUrl()) {
      throw new SessionLifecycleChangedError();
    }
  }

  // ─── Auto-lock ────────────────────────────────────────────────────────────

  /** Record user activity and push the idle deadline out (no-op while locked). */
  async touchActivity(): Promise<void> {
    if (!this.getKeys()) return;
    const generation = this.captureLifecycleGeneration();
    const at = this.now();
    const record = await this.store.getAutoLock();
    if (!this.isLifecycleCurrent(generation) || !this.getKeys()) return;
    const policy = record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
    await this.store.setAutoLock({ policy, lastActivityAt: at });
    if (!this.isLifecycleCurrent(generation) || !this.getKeys()) return;
    if (this.sharedUnlockLimits) {
      const idle = policyIdleMs(policy);
      this.sharedUnlockLimits = {
        ...this.sharedUnlockLimits,
        idleDeadlineMs: Math.min(idle === null ? Infinity : at + idle,
          this.sharedUnlockLimits.absoluteDeadlineMs, this.sharedUnlockLimits.offlineDeadlineMs),
      };
    }
    this.autoLock.arm(policy, at, this.sharedUnlockLimits ? unlockDeadline(this.sharedUnlockLimits) : undefined);
    const idle = policyIdleMs(policy);
    this.sharedUnlockLocalDeadline = idle === null ? Infinity : at + idle;
  }

  async getAutoLockPolicy(): Promise<AutoLockPolicy> {
    const record = await this.store.getAutoLock();
    return record?.policy ?? DEFAULT_AUTO_LOCK_POLICY;
  }

  /** Change the idle policy (settings UI is CVT-370); re-arms immediately. */
  async setAutoLockPolicy(policy: AutoLockPolicy): Promise<void> {
    const at = this.now();
    await this.store.setAutoLock({ policy, lastActivityAt: at });
    if (this.getKeys()) {
      this.autoLock.arm(policy, at,
        this.sharedUnlockLimits ? unlockDeadline(this.sharedUnlockLimits) : undefined);
      const idle = policyIdleMs(policy);
      this.sharedUnlockLocalDeadline = idle === null ? Infinity : at + idle;
    }
  }
}
