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

export {
  isSecurePage,
  matchesTab,
  registrableDomain,
  type MatchOptions,
} from "@shared/security/domain";
