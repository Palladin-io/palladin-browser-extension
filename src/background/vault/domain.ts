/**
 * The strict origin gate (plan §8.1, AGENTS.md → Security First).
 *
 * A fill is allowed only when the active tab's normalized host equals the
 * entry's registered host, and only over HTTPS. This is the single place that answer is
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
 * SECURITY: subdomains do NOT match by default. `login.example.com`,
 * `example.com`, and `evil.example.com` are distinct fill targets. A per-entry
 * opt-in can request site-wide matching through {@link MatchOptions}; absent
 * that explicit opt-in, exact-host matching is fail-closed.
 */

export {
  isSecurePage,
  matchesTab,
  registrableDomain,
  type MatchOptions,
} from "@shared/security/domain";
