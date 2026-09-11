import type { SessionKeys, SessionTokens } from "./types";
import type { SessionUnlockLimits } from "./shared-unlock-install";

/** Worker-only borrowed own session, never part of browser messaging. */
export interface SharedUnlockSourceSession {
  readonly signal: AbortSignal;
  /** Reads current effective limits and refuses stale keys/tokens/generations. */
  read(): { tokens: SessionTokens; keys: SessionKeys; limits: SessionUnlockLimits };
  /** Releases retained references; does not lock or modify the own session. */
  dispose(): void;
}
