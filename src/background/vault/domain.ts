/**
 * The strict origin gate (plan §8.1, AGENTS.md → Security First).
 *
 * A fill is allowed only when the active tab's registrable domain (eTLD+1,
 * resolved through the Public Suffix List) equals the entry's registered
 * domain, and only over HTTPS. This is the single place that answer is
 * computed, so the popup (for display) and the fill command (for the hard
 * gate) can never drift apart.
 *
 * We use `tldts` — the same PSL library the web panel already ships (see
 * `react-web-panel` `entry-presentation.ts`). Its data is bundled, so nothing
 * is fetched at runtime (MV3 forbids remote code). `allowPrivateDomains: true`
 * treats private suffixes (github.io, herokuapp.com, ...) as public suffixes,
 * so two tenants of a shared host (`a.github.io` vs `b.github.io`) never share
 * a registrable domain and therefore never match — the safe default.
 *
 * SECURITY: subdomains do NOT match by default. Because both sides are reduced
 * to the registrable domain, `login.example.com` and `example.com` share
 * `example.com` and match (same site, intended), while `evil.com` never matches
 * `example.com`. A future per-entry opt-in for strict subdomain binding plugs in
 * at {@link MatchOptions} without touching callers.
 */

import { getDomain } from "tldts";

const PSL_OPTIONS = { allowPrivateDomains: true } as const;

/**
 * The registrable domain (eTLD+1) of a URL or bare hostname, or `null` when the
 * input has no registrable domain (an IP, a raw suffix like `github.io`, an
 * unparseable value). `tldts` accepts either a full URL or a hostname.
 */
export function registrableDomain(input: string | undefined | null): string | null {
  if (!input) return null;
  return getDomain(input, PSL_OPTIONS);
}

/** Reserved slot for a future per-entry subdomain opt-in (plan §8.1). */
export interface MatchOptions {
  /** When true, require an exact host match instead of eTLD+1. Not wired yet. */
  readonly exactSubdomain?: boolean;
}

/**
 * Does an entry whose stored `urlDomain` is `entryDomain` match the active tab
 * at `tabUrl`? True only when both resolve to the same non-null registrable
 * domain. An entry with no domain is fail-closed (never matches) — mirrors the
 * inject channel contract.
 */
export function matchesTab(
  tabUrl: string | undefined | null,
  entryDomain: string | undefined | null,
  _options: MatchOptions = {},
): boolean {
  const tab = registrableDomain(tabUrl);
  const entry = registrableDomain(entryDomain);
  return tab !== null && entry !== null && tab === entry;
}

/** Only `https:` pages may be filled (plan §8.1). Anything else is blocked. */
export function isSecurePage(tabUrl: string | undefined | null): boolean {
  if (!tabUrl) return false;
  try {
    return new URL(tabUrl).protocol === "https:";
  } catch {
    return false;
  }
}
