/**
 * Private content-script <-> worker liveness messages.
 *
 * They never cross the page-facing Window bridge and carry no session state
 * beyond the coarse instruction to keep the already-unlocked worker alive.
 */

export const SESSION_LIVENESS_CHANNEL = "palladin.session/liveness" as const;
export const SESSION_LIVENESS_INTERVAL_MS = 20_000;

export interface SessionLivenessControl {
  readonly channel: typeof SESSION_LIVENESS_CHANNEL;
  readonly type: "control";
  readonly enabled: boolean;
}

export interface SessionLivenessPing {
  readonly channel: typeof SESSION_LIVENESS_CHANNEL;
  readonly type: "ping";
}

export function sessionLivenessControl(enabled: boolean): SessionLivenessControl {
  return { channel: SESSION_LIVENESS_CHANNEL, type: "control", enabled };
}

export function isSessionLivenessControl(value: unknown): value is SessionLivenessControl {
  return hasExactKeys(value, ["channel", "type", "enabled"])
    && value.channel === SESSION_LIVENESS_CHANNEL
    && value.type === "control"
    && typeof value.enabled === "boolean";
}

export function isSessionLivenessPing(value: unknown): value is SessionLivenessPing {
  return hasExactKeys(value, ["channel", "type"])
    && value.channel === SESSION_LIVENESS_CHANNEL
    && value.type === "ping";
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  expected: T,
): value is Record<T[number], unknown> {
  if (typeof value !== "object" || value === null) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}
