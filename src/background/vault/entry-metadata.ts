/**
 * In-memory presentation projection opened from the encrypted MemberIndex
 * cache while the worker is unlocked. The persistent IndexedDB cache contains
 * only ciphertext; this plaintext projection must never be stored or logged.
 *
 * MemberIndex intentionally includes the credential username so list/search
 * and autofill suggestions do not need to download and open MemberSecret for
 * every row. Passwords, TOTP seeds and other secret payload fields remain in
 * MemberSecret and are opened only for an explicit fill/reveal operation.
 */

import { matchesTab } from "./domain";

export const ENTRY_TYPE_KEY = 0 as const;
export const ENTRY_TYPE_CREDENTIAL = 1 as const;
export const ENTRY_TYPE_SCRIPT = 2 as const;
export const ENTRY_TYPE_CREDIT_CARD = 3 as const;
export type EntryTypeCode =
  | typeof ENTRY_TYPE_KEY
  | typeof ENTRY_TYPE_CREDENTIAL
  | typeof ENTRY_TYPE_SCRIPT
  | typeof ENTRY_TYPE_CREDIT_CARD;

/** One unlocked, memory-only projection. It never contains key material. */
export interface EntryMetadata {
  readonly id: string;
  readonly vaultId: string;
  /** Decrypted Vault label, shown only while the member session is unlocked. */
  readonly vaultName: string;
  readonly name: string;
  readonly type: EntryTypeCode;
  /** Credential username from MemberIndex; absent for other entry types. */
  readonly username?: string;
  readonly urlDomain?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly updatedAt: string;
}

/** Entries whose registered domain matches the active tab (plan §8.1 gate). */
export function entriesForTab(
  entries: readonly EntryMetadata[],
  tabUrl: string | undefined | null,
): EntryMetadata[] {
  if (!tabUrl) return [];
  return entries.filter((entry) => matchesTab(tabUrl, entry.urlDomain));
}

/**
 * Entries on a sibling host of the same registrable domain. These are discovery
 * candidates only: callers must keep them behind an explicit, per-entry user
 * choice and the fill path must repeat the related-domain gate before decrypt.
 */
export function relatedEntriesForTab(
  entries: readonly EntryMetadata[],
  tabUrl: string | undefined | null,
): EntryMetadata[] {
  if (!tabUrl) return [];
  return entries.filter((entry) =>
    !matchesTab(tabUrl, entry.urlDomain)
    && matchesTab(tabUrl, entry.urlDomain, { exactSubdomain: false }));
}

/**
 * Local free-text search across the unlocked MemberIndex projection. An empty
 * query returns everything, sorted by name for a stable list.
 */
export function searchEntries(
  entries: readonly EntryMetadata[],
  query: string,
): EntryMetadata[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(q) ||
          (entry.urlDomain?.toLowerCase().includes(q) ?? false) ||
          (entry.username?.toLowerCase().includes(q) ?? false),
      )
    : [...entries];
  return matched.sort((a, b) => a.name.localeCompare(b.name));
}
