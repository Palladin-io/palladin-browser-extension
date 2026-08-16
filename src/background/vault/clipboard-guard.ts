/**
 * Clipboard hygiene: after the popup copies a secret (username, password, TOTP),
 * the worker schedules a one-shot alarm to wipe the clipboard a short time later
 * so a decrypted value does not linger where another app could read it.
 *
 * The SCHEDULING decision lives here (pure, injectable, tested); the actual wipe
 * is an injected effect (an offscreen document, wired in the runtime) since a
 * service worker has no clipboard of its own. Re-arming simply reschedules the
 * single alarm, so rapid successive copies collapse to one deadline measured
 * from the last copy.
 */

import type { AlarmScheduler } from "../session/auto-lock";

export const CLIPBOARD_CLEAR_ALARM = "palladin.clipboard.clear";
export const CLIPBOARD_TTL_MS = 30_000;

export interface ClipboardGuardDeps {
  alarms: AlarmScheduler;
  /** Effect that empties the clipboard (offscreen document in the runtime). */
  clear: () => Promise<void>;
  ttlMs?: number;
  now?: () => number;
}

export class ClipboardGuard {
  private readonly alarms: AlarmScheduler;
  private readonly clear: () => Promise<void>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(deps: ClipboardGuardDeps) {
    this.alarms = deps.alarms;
    this.clear = deps.clear;
    this.ttlMs = deps.ttlMs ?? CLIPBOARD_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Schedule (or reschedule) the clipboard wipe for `ttlMs` from now. */
  arm(): void {
    this.alarms.create(CLIPBOARD_CLEAR_ALARM, { when: this.now() + this.ttlMs });
  }

  /** Run the wipe when the clipboard alarm fires; ignore any other alarm. */
  async handleAlarm(name: string): Promise<void> {
    if (name === CLIPBOARD_CLEAR_ALARM) await this.clear();
  }
}
