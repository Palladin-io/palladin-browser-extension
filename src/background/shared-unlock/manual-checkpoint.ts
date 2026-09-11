import type { SharedUnlockExpiryScope, SharedUnlockExpiryStore } from "./expiry-store";

/** A final shorter local policy must be durable before this own manual session
 * can share. Failure disables only that root's sharing, preserving ordinary
 * password unlock; an already successful initial checkpoint fences older roots. */
export async function persistManualSharedUnlockDeadline(scope: SharedUnlockExpiryScope, sequence: number,
  deadlineMs: number, store: SharedUnlockExpiryStore, assertCurrent: () => void, disableOwnSharing: () => void): Promise<number> {
  assertCurrent();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const until = Date.now() + 2_000;
  try {
    const saved = await Promise.race([
      store.checkpoint(scope, sequence, deadlineMs),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Shared unlock checkpoint unavailable")), 2_000); }),
    ]);
    assertCurrent();
    if (Date.now() >= until) throw new Error("Shared unlock checkpoint expired");
    return saved;
  } catch {
    assertCurrent();
    disableOwnSharing();
    assertCurrent();
    return deadlineMs;
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
