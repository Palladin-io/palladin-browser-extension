/**
 * Entry metadata: the non-secret, discovery-level facts the service worker
 * caches for every entry so the popup can list and match without touching a
 * secret. This is exactly the shape the backend already exposes org-wide for
 * agent discovery (label, description, urlDomain — CVT-204); it is NOT the
 * encrypted blob and never carries a username, password, or TOTP seed.
 *
 * SECURITY: a username hint and "has TOTP" live inside the encrypted blob, not
 * in list metadata. Surfacing them would mean bulk-decrypting every entry the
 * moment the popup opens — exactly what the zero-knowledge cache rule forbids
 * (cache holds ciphertext/metadata only). So the list search matches on name +
 * domain, and TOTP is discovered on demand when a row is opened.
 */

import { matchesTab } from "./domain";

/** Entry types serialised by the backend as camelCase strings. */
export type EntryTypeWire = "key" | "credential" | "script" | number;

export const ENTRY_TYPE_KEY = 0 as const;
export const ENTRY_TYPE_CREDENTIAL = 1 as const;
export const ENTRY_TYPE_SCRIPT = 2 as const;
export type EntryTypeCode =
  | typeof ENTRY_TYPE_KEY
  | typeof ENTRY_TYPE_CREDENTIAL
  | typeof ENTRY_TYPE_SCRIPT;

/**
 * Normalise the wire `type` (camelCase string, or a legacy integer) into the
 * numeric code the client compares against — mirrors the web panel boundary
 * normalisation so `"credential"` never silently compares unequal to `1`.
 */
export function normalizeEntryType(raw: EntryTypeWire): EntryTypeCode {
  const value = typeof raw === "string" ? raw.toLowerCase() : raw;
  if (value === "key" || value === ENTRY_TYPE_KEY) return ENTRY_TYPE_KEY;
  if (value === "script" || value === ENTRY_TYPE_SCRIPT) return ENTRY_TYPE_SCRIPT;
  return ENTRY_TYPE_CREDENTIAL;
}

/**
 * One cached entry. Every field is non-secret: `name` is the label, `urlDomain`
 * is the stored host, `type` picks the fill/copy affordances. No key material.
 */
export interface EntryMetadata {
  readonly id: string;
  readonly vaultId: string;
  readonly name: string;
  readonly type: EntryTypeCode;
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
 * Local free-text search across the cached metadata: case-insensitive substring
 * over name and domain (username is not in metadata — see the module note). An
 * empty query returns everything, sorted by name for a stable list.
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
          (entry.urlDomain?.toLowerCase().includes(q) ?? false),
      )
    : [...entries];
  return matched.sort((a, b) => a.name.localeCompare(b.name));
}
