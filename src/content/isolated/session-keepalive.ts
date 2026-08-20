import {
  SESSION_LIVENESS_CHANNEL,
  SESSION_LIVENESS_INTERVAL_MS,
  type SessionLivenessPing,
} from "@shared/messaging";

export const SESSION_KEEPALIVE_INTERVAL_MS = SESSION_LIVENESS_INTERVAL_MS;

export interface SessionKeepaliveTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SessionKeepalive {
  setEnabled(enabled: boolean): void;
  stop(): void;
}

/**
 * Keeps an unlocked MV3 worker alive without carrying or persisting any secret.
 * The ping deliberately does not count as user activity, so it never extends
 * the configured auto-lock deadline.
 */
export function createSessionKeepalive(
  send: (message: SessionLivenessPing) => void,
  timers: SessionKeepaliveTimers,
): SessionKeepalive {
  let handle: unknown | null = null;

  function stop(): void {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  return {
    setEnabled(enabled) {
      stop();
      if (!enabled) return;
      handle = timers.setInterval(() => {
        send({ channel: SESSION_LIVENESS_CHANNEL, type: "ping" });
      }, SESSION_KEEPALIVE_INTERVAL_MS);
    },
    stop,
  };
}
