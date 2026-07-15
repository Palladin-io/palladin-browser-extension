/**
 * Idle auto-lock driven by `chrome.alarms`.
 *
 * The extension locks itself after a configurable idle window. We hang the timer
 * on `chrome.alarms` (not `setTimeout`) because an MV3 service worker is
 * routinely torn down between events — an alarm survives that teardown, a timer
 * does not. Each user activity re-arms the alarm to `lastActivity + idle`, so the
 * alarm only ever fires once the window has genuinely elapsed with no activity.
 *
 * `on-close` schedules no alarm: keys live in `chrome.storage.session`, which the
 * browser already clears on shutdown, so "lock when the browser closes" needs no
 * timer of our own. The idle policies are the ones that require scheduling.
 *
 * SECURITY: locking wipes key material (see {@link ./session-manager}); this
 * module only decides *when*, and carries no secret in the alarm payload.
 */

export const AUTO_LOCK_ALARM = "palladin.autolock" as const;

export const AUTO_LOCK_POLICIES = ["15m", "1h", "4h", "on-close"] as const;
export type AutoLockPolicy = (typeof AUTO_LOCK_POLICIES)[number];

/** 4 hours — "unlock once, then out of the way for the working session" (plan §5). */
export const DEFAULT_AUTO_LOCK_POLICY: AutoLockPolicy = "4h";

const MINUTE_MS = 60_000;

/** Idle window in ms, or `null` for `on-close` (no idle alarm). */
export function policyIdleMs(policy: AutoLockPolicy): number | null {
  switch (policy) {
    case "15m":
      return 15 * MINUTE_MS;
    case "1h":
      return 60 * MINUTE_MS;
    case "4h":
      return 4 * 60 * MINUTE_MS;
    case "on-close":
      return null;
  }
}

export function isAutoLockPolicy(value: unknown): value is AutoLockPolicy {
  return (
    typeof value === "string" &&
    (AUTO_LOCK_POLICIES as readonly string[]).includes(value)
  );
}

/** Minimal slice of `chrome.alarms` this module needs — injectable for tests. */
export interface AlarmScheduler {
  create(name: string, info: { when?: number; delayInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
}

export class AutoLock {
  constructor(
    private readonly alarms: AlarmScheduler,
    private readonly onFire: () => void,
  ) {}

  /** (Re)arm the idle alarm for the given policy relative to `lastActivityAt`. */
  arm(policy: AutoLockPolicy, lastActivityAt: number): void {
    const idle = policyIdleMs(policy);
    if (idle === null) {
      // `on-close`: nothing to schedule; storage.session dies with the browser.
      void this.alarms.clear(AUTO_LOCK_ALARM);
      return;
    }
    this.alarms.create(AUTO_LOCK_ALARM, { when: lastActivityAt + idle });
  }

  /** Cancel the idle alarm (on lock / logout). */
  disarm(): void {
    void this.alarms.clear(AUTO_LOCK_ALARM);
  }

  /**
   * Feed a fired alarm in. Locks only when it is our alarm; a re-arm on activity
   * means a stale alarm can never fire early, so a match here is a real timeout.
   */
  dispatch(alarmName: string): void {
    if (alarmName === AUTO_LOCK_ALARM) this.onFire();
  }
}
