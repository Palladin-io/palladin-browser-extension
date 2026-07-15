/**
 * Web-panel URL config for the popup's deep links ("Open Palladin", "open in
 * web panel"). Heavy management lives in the panel, not the popup (plan §4), so
 * the popup only ever needs to build a link to it.
 *
 * Like the API URL, one Chromium build serves every environment: this defaults
 * to the local panel and lets a build-time `VITE_WEB_APP_URL` override it for
 * staging/production packaging. Nothing here is secret.
 */

const DEFAULT_WEB_APP_URL = "http://localhost:5173";

type EnvSource = Record<string, string | undefined>;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveWebAppUrl(source: EnvSource): string {
  const configured = source["VITE_WEB_APP_URL"];
  return trimTrailingSlash(configured && configured.length > 0 ? configured : DEFAULT_WEB_APP_URL);
}

export const webAppUrl: string = resolveWebAppUrl(
  import.meta.env as unknown as EnvSource,
);

/** Deep link to an entry's detail page in the web panel. */
export function entryDeepLink(vaultId: string, entryId: string): string {
  return `${webAppUrl}/vaults/${vaultId}/entries/${entryId}`;
}
