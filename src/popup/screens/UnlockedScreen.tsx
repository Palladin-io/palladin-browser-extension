import { useState } from "react";

import { Button } from "../components/Button";

/**
 * Unlocked state. The entry list, search and generator land in CVT-368; for now
 * this is a clean extension point plus the two session actions. Lock keeps the
 * account signed in (keys wiped, quick re-unlock); Sign out clears everything.
 */
export interface UnlockedScreenProps {
  onLock(): Promise<void>;
  onSignOut(): Promise<void>;
}

export function UnlockedScreen({ onLock, onSignOut }: UnlockedScreenProps): React.JSX.Element {
  const [busy, setBusy] = useState<"lock" | "signout" | null>(null);

  async function run(kind: "lock" | "signout", action: () => Promise<void>): Promise<void> {
    setBusy(kind);
    try {
      await action();
    } catch {
      // The worker owns the source of truth; if the action failed the phase
      // simply stays "unlocked" and the user can retry. No secret to surface.
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="screen-title">You're unlocked</h2>
      <p className="screen-subtitle">Your vault is ready for you and your agents.</p>

      {/* Extension point for the entry list / search / generator (CVT-368). */}
      <div className="unlocked-slot">
        <span className="unlocked-slot-title">Entries for this site</span>
        <span className="unlocked-slot-hint">
          Autofill and your vault list arrive in the next update.
        </span>
      </div>

      <div className="unlocked-actions">
        <Button
          variant="subtle"
          onClick={() => run("lock", onLock)}
          loading={busy === "lock"}
          disabled={busy !== null}
        >
          Lock
        </Button>
        <Button
          variant="danger"
          onClick={() => run("signout", onSignOut)}
          loading={busy === "signout"}
          disabled={busy !== null}
        >
          Sign out
        </Button>
      </div>
    </section>
  );
}
