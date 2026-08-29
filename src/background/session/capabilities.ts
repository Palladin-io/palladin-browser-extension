/**
 * Session capabilities the popup queries over the command channel to decide
 * which unlock affordances to render — today just whether an authorized Rust
 * runtime can unlock via biometrics.
 *
 * This is intentionally a plain, dependency-free snapshot: the popup asks once,
 * and the reserved {@link ./unlock-source.RuntimeUnlock} slot means the answer
 * is `false` until E2 wires reviewed runtime unlock authorization. Keeping the flag here (not
 * in the popup) means the SW stays the single source of truth for what the
 * session can actually do.
 */

/**
 * Reserved for E2: flips to `true` once the extension has a separately reviewed native
 * Rust runtime (Touch ID / Windows Hello unlock, plan §5). While it is `false`
 * the popup keeps the biometric button hidden — {@link ./unlock-source.RuntimeUnlock}
 * rejects every call, so offering the button would be a dead end.
 */
const RUNTIME_UNLOCK_AVAILABLE = false;

export interface SessionCapabilities {
  /** True when a biometric unlock via an authorized runtime is available (E2). */
  readonly runtimeUnlock: boolean;
}

export function getSessionCapabilities(): SessionCapabilities {
  return { runtimeUnlock: RUNTIME_UNLOCK_AVAILABLE };
}
