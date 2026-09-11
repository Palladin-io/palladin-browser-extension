import { SharedUnlockApi } from "./api";
import type { SharedUnlockAuthorization } from "./api-types";
import type { SharedUnlockExpiryStore } from "./expiry-store";
import type { SharedUnlockSourceAuthority } from "./source-authority";

export interface OwnSharedUnlockActivity {
  readonly session: { apiUrl: string; userId: string; accessToken: string; refreshToken: string };
  readonly authority: ReturnType<SharedUnlockSourceAuthority["captureActivity"]>;
  readonly idleDeadlineMs: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  dispose(): void;
}

/** One own request plus at most one latest observed input. No heartbeat, peer
 * trigger, retry or recomputation of an input's deadline when the queue runs. */
export class OwnSharedUnlockActivityRecorder {
  private queued: OwnSharedUnlockActivity | null = null;
  private running = false;
  private nextStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly api: SharedUnlockApi;
  private readonly expiry: SharedUnlockExpiryStore;
  constructor(api: SharedUnlockApi, expiry: SharedUnlockExpiryStore) { this.api = api; this.expiry = expiry; }
  record(activity: OwnSharedUnlockActivity): void {
    this.queued?.dispose();
    this.queued = activity;
    this.schedule();
  }
  private schedule(): void {
    if (this.running || this.timer || !this.queued) return;
    const delay = Math.max(0, this.nextStart - Date.now());
    if (delay) this.timer = setTimeout(() => { this.timer = null; this.schedule(); }, delay);
    else void this.run();
  }
  private async run(): Promise<void> {
    const activity = this.queued;
    if (!activity) return;
    this.queued = null; this.running = true; this.nextStart = Date.now() + 1_000;
    const abort = new AbortController(), until = Date.now() + 2_000;
    const cancel = () => abort.abort();
    activity.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 2_000);
    const check = () => {
      if (abort.signal.aborted || activity.signal.aborted || Date.now() >= until) throw new Error("Own activity expired");
      activity.assertCurrent(); activity.authority.assertCurrent();
    };
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const cancelled = () => reject(new Error("Own activity cancelled"));
      if (abort.signal.aborted) cancelled();
      else abort.signal.addEventListener("abort", cancelled, { once: true });
      promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", cancelled));
    });
    try {
      check();
      const root = activity.authority.authorization;
      const idleDeadlineMs = Math.min(activity.idleDeadlineMs, root.absoluteDeadlineMs, root.offlineDeadlineMs);
      await wait(this.expiry.renewOwn({ apiUrl: activity.session.apiUrl, accountId: activity.session.userId }, root.sequence,
        idleDeadlineMs, check));
      check();
      const updated: SharedUnlockAuthorization = await wait(this.api.recordActivity(activity.session,
        { authorizationId: root.authorizationId, sourceGeneration: activity.authority.generation, idleDeadlineMs }, abort.signal));
      check();
      activity.authority.apply(updated);
    } catch { /* No retry or manufactured fresh password proof. Ordinary own keys stay subject to their local limits. */ }
    finally {
      clearTimeout(timer); activity.signal.removeEventListener("abort", cancel); abort.abort();
      activity.dispose(); this.running = false; this.schedule();
    }
  }
}
