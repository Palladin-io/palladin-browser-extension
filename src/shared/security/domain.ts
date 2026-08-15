/**
 * Canonical HTTPS and registrable-domain gate shared by the service worker and
 * isolated content script. Keeping one implementation prevents the final
 * pre-write check from accepting a broader origin set than the worker.
 */
import { getDomain } from "tldts";

const PSL_OPTIONS = { allowPrivateDomains: true } as const;

export function registrableDomain(input: string | undefined | null): string | null {
  if (!input) return null;
  return getDomain(input, PSL_OPTIONS);
}

export interface MatchOptions {
  readonly exactSubdomain?: boolean;
}

export function matchesTab(
  tabUrl: string | undefined | null,
  entryDomain: string | undefined | null,
  _options: MatchOptions = {},
): boolean {
  const tab = registrableDomain(tabUrl);
  const entry = registrableDomain(entryDomain);
  return tab !== null && entry !== null && tab === entry;
}

/**
 * Agent Inject uses the runtime-authenticated Entry host, not a caller-supplied
 * registrable-domain hint. Match the exact host or one of its descendants so an
 * Entry bound to login.example.com cannot release into evil.example.com.
 */
export function matchesAgentInjectionTarget(
  tabUrl: string | undefined | null,
  expectedDomain: string | undefined | null,
): boolean {
  if (!tabUrl || !expectedDomain || registrableDomain(expectedDomain) === null) return false;
  try {
    const active = new URL(tabUrl).hostname.toLowerCase().replace(/\.$/, "");
    const expected = expectedDomain.toLowerCase().replace(/\.$/, "");
    return active === expected || active.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

export function isSecurePage(tabUrl: string | undefined | null): boolean {
  if (!tabUrl) return false;
  try {
    return new URL(tabUrl).protocol === "https:";
  } catch {
    return false;
  }
}
