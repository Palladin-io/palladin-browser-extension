import type { SessionManager } from "../session/session-manager";
import type { SharedUnlockSourceAuthority } from "./source-authority";
import type { SharedUnlockExpiryStore } from "./expiry-store";
import { persistManualSharedUnlockDeadline } from "./manual-checkpoint";

/** Worker-only local policy restriction. No Identity activity or new proof. */
export async function recordExtensionOwnPolicy(manager: SessionManager, source: SharedUnlockSourceAuthority,
  store: SharedUnlockExpiryStore): Promise<void> {
  let own: ReturnType<SessionManager["captureSharedUnlockSource"]> | null = null;
  try {
    const witness = source.closingWitness();
    if (!witness) return;
    own = manager.captureSharedUnlockSource();
    const captured = own, { tokens, limits } = captured.read();
    const check = () => {
      captured.read();
      const current = source.closingWitness();
      if (current?.authorizationId !== witness.authorizationId || current.sourceGeneration !== witness.sourceGeneration) {
        throw new Error("Own policy generation changed");
      }
    };
    source.restrictIdleDeadline(limits.idleDeadlineMs);
    check();
    await persistManualSharedUnlockDeadline({ apiUrl: tokens.apiUrl, accountId: tokens.userId }, witness.sequence,
      limits.idleDeadlineMs, store, check, () => source.suspendSharing(), Math.min(limits.absoluteDeadlineMs, limits.offlineDeadlineMs));
  } catch { /* A changed/locked own generation must not modify its successor. */ }
  finally { own?.dispose(); }
}
