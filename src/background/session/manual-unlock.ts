import type { AccountResponse } from "./auth-client";
import type { SessionUnlockLimits } from "./shared-unlock-install";
import type { SessionTokens } from "./types";

/** Worker-only fresh password proof. Borrowed bytes are wiped when the call ends. */
export interface ManualUnlockContext {
  readonly tokens: SessionTokens;
  readonly account: AccountResponse;
  readonly authCredential: Uint8Array;
  readonly limits: SessionUnlockLimits;
  assertCurrent(): void;
}

/** Establish own sharing authority while the manual unlock is still in progress. */
export type PrepareManualUnlock = (context: ManualUnlockContext) => Promise<SessionUnlockLimits | null>;
