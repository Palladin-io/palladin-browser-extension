/**
 * Session lifecycle hooks — the extension points later phases plug into.
 *
 * The session manager emits `unlocked` / `locked` through {@link SessionHooks};
 * the sync engine (CVT-375) and push registration (CVT-375/376) subscribe. They
 * are typed slots today: the manager fires them, but the heavy behaviour arrives
 * with those tasks. Keeping the contract here means the manager never grows a
 * hard dependency on sync or FCM.
 *
 * SECURITY: a lifecycle event carries NO key material — only the fact that the
 * session changed state, plus the non-secret userId. Subscribers that need keys
 * ask the manager explicitly.
 */

export interface SessionLifecycleEvent {
  readonly userId: string;
}

export type SessionHookListener = (event: SessionLifecycleEvent) => void;

/** Tiny synchronous event bus for `unlocked` / `locked`. */
export class SessionHooks {
  private readonly onUnlockedListeners = new Set<SessionHookListener>();
  private readonly onLockedListeners = new Set<SessionHookListener>();

  onUnlocked(listener: SessionHookListener): () => void {
    this.onUnlockedListeners.add(listener);
    return () => this.onUnlockedListeners.delete(listener);
  }

  onLocked(listener: SessionHookListener): () => void {
    this.onLockedListeners.add(listener);
    return () => this.onLockedListeners.delete(listener);
  }

  emitUnlocked(event: SessionLifecycleEvent): void {
    for (const listener of this.onUnlockedListeners) listener(event);
  }

  emitLocked(event: SessionLifecycleEvent): void {
    for (const listener of this.onLockedListeners) listener(event);
  }
}

/**
 * Delta-sync trigger (CVT-375). The session manager calls {@link requestSync} on
 * unlock; the sync engine implements it. `NoopSyncTrigger` is the wired default
 * until that engine exists.
 */
export interface SyncTrigger {
  requestSync(reason: SyncReason): void;
}

export type SyncReason = "unlocked" | "alarm" | "push";

export class NoopSyncTrigger implements SyncTrigger {
  requestSync(_reason: SyncReason): void {
    /* sync engine lands in CVT-375 */
  }
}

/**
 * Push (FCM) registration slot (CVT-375/376). Registering a device token needs
 * an authenticated session, so the manager hands the tokenward call off here on
 * unlock. `NoopPushRegistration` is the wired default.
 */
export interface PushRegistration {
  register(userId: string): Promise<void>;
  unregister(userId: string): Promise<void>;
}

export class NoopPushRegistration implements PushRegistration {
  register(_userId: string): Promise<void> {
    return Promise.resolve();
  }
  unregister(_userId: string): Promise<void> {
    return Promise.resolve();
  }
}
