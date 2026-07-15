/**
 * Local, case-insensitive search over the cached metadata — name and domain
 * only. Username is intentionally not searchable: it lives inside the encrypted
 * blob, and matching it would require decrypting every entry on each keystroke,
 * which the zero-knowledge cache rule forbids. Kept in the popup (not imported
 * from the background) so the popup bundle stays free of the PSL library.
 */

import type { EntryMetadata } from "../../background/vault/entry-metadata";

export function filterEntries(
  entries: readonly EntryMetadata[],
  query: string,
): EntryMetadata[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(q) ||
      (entry.urlDomain?.toLowerCase().includes(q) ?? false),
  );
}
