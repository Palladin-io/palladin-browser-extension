/**
 * Environment configuration for the service worker.
 *
 * One Chromium build serves every environment, so — unlike the web panel, which
 * bakes `VITE_API_URL` at build time and throws when it is missing — the
 * extension defaults to the local backend and lets a build-time `VITE_*` var
 * override it for staging/production packaging. Nothing here is secret: it is
 * only the backend base URL and the (public) PostHog project key.
 *
 * `resolveEnv` is pure so tests can pin values without touching `import.meta`.
 */

export interface ExtensionEnv {
  /** Backend REST base URL, no trailing slash. */
  readonly apiUrl: string;
  /** PostHog project key. Empty string disables analytics (see {@link ./..\/telemetry/analytics}). */
  readonly posthogKey: string;
  /** PostHog ingestion host. */
  readonly posthogHost: string;
}

const DEFAULTS = {
  // Local backend (see root CLAUDE.md → Environments). Staging/production
  // packaging overrides this with `VITE_API_URL`.
  apiUrl: "http://localhost:5000",
  posthogHost: "https://eu.i.posthog.com",
} as const;

/** Placeholders documenting the not-yet-provisioned hosted environments. */
export const API_URL_PLACEHOLDERS = {
  staging: "https://api.stage.palladin.io",
  production: "https://api.palladin.io",
} as const;

type EnvSource = Record<string, string | undefined>;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveEnv(source: EnvSource): ExtensionEnv {
  const apiUrl = source["VITE_API_URL"];
  const posthogKey = source["VITE_POSTHOG_KEY"];
  const posthogHost = source["VITE_POSTHOG_HOST"];
  return {
    apiUrl: trimTrailingSlash(apiUrl && apiUrl.length > 0 ? apiUrl : DEFAULTS.apiUrl),
    posthogKey: posthogKey ?? "",
    posthogHost: posthogHost && posthogHost.length > 0 ? posthogHost : DEFAULTS.posthogHost,
  };
}

export const env: ExtensionEnv = resolveEnv(
  import.meta.env as unknown as EnvSource,
);
