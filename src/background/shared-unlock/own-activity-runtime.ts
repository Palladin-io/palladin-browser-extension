import type { SessionManager } from "../session/session-manager";
import type { SharedUnlockSourceAuthority } from "./source-authority";
import type { OwnSharedUnlockActivityRecorder } from "./own-activity";

/** Worker-only composition invoked after locally admitted input. No peer can
 * provide tokens, root identity, keys, limits or the own lifecycle fence. */
export function recordExtensionOwnActivity(manager: SessionManager, source: SharedUnlockSourceAuthority, recorder: OwnSharedUnlockActivityRecorder): void {
  const own = manager.captureSharedUnlockSource();
  let authority: ReturnType<SharedUnlockSourceAuthority["captureActivity"]> | null = null;
  try {
    const state = own.read();
    authority = source.captureActivity();
    const selected = authority;
    recorder.record({ session: state.tokens, authority: selected, idleDeadlineMs: state.limits.idleDeadlineMs,
      signal: own.signal, assertCurrent: () => { own.read(); },
      dispose: () => { selected.dispose(); own.dispose(); } });
  } catch { authority?.dispose(); own.dispose(); }
}
