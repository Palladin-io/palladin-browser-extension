import type { AccountMaterial, SessionKeys, SessionTokens } from "./types";

/** Authoritative original times from the consumed and committed operation. */
export interface SessionUnlockLimits {
  readonly unlockedAtMs: number;
  readonly idleDeadlineMs: number;
  readonly absoluteDeadlineMs: number;
  readonly offlineDeadlineMs: number;
}

export const unlockDeadline = (limits: SessionUnlockLimits): number =>
  Math.min(limits.idleDeadlineMs, limits.absoluteDeadlineMs, limits.offlineDeadlineMs);

export interface SharedUnlockInstallation {
  /** Receiver's own Identity commit response; never supplied through the peer. */
  readonly tokens: SessionTokens;
  readonly material: AccountMaterial;
  /** Already unwrapped and bound to Identity's independent member public key. */
  readonly keys: SessionKeys;
  readonly limits: SessionUnlockLimits;
}

/** Worker-only transaction captured before consume/commit or any key recovery. */
export interface SharedUnlockInstaller {
  assertCurrent(): void;
  /** Takes ownership of keys even when cancelled, expired or already consumed. */
  install(installation: SharedUnlockInstallation): Promise<void>;
  cancel(): void;
}
