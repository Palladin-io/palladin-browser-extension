import type { MemberSecretV1 } from "@palladin/crypto";

import type { EntryMetadata } from "./entry-metadata";

/**
 * Small command-facing seam for the canonical Protocol 2 runtime. Plaintext is
 * always transient worker memory.
 */
export interface VaultDataSource {
  refresh(): Promise<EntryMetadata[]>;
  /** Return cached metadata when the last authoritative refresh is still fresh. */
  refreshIfStale(maxAgeMs: number): Promise<EntryMetadata[]>;
  getMetadata(): Promise<EntryMetadata[]>;
  revealEntry(vaultId: string, entryId: string): Promise<MemberSecretV1>;
  clearCache(): Promise<void>;
}
