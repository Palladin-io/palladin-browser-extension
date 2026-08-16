export const PRODUCTION_API_URL = "https://api.palladin.io";
export const STAGING_API_URL = "https://api.stage.palladin.io";
export const LOCAL_API_URL = "http://localhost:5000";

export const REQUIRED_API_URLS = [
  PRODUCTION_API_URL,
  STAGING_API_URL,
  LOCAL_API_URL,
] as const;

export function normalizeServerUrl(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.protocol !== "https:" && !isLoopbackHttp(parsed)) return null;

  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export function serverPermissionOrigin(apiUrl: string): string | null {
  const normalized = normalizeServerUrl(apiUrl);
  if (normalized === null) return null;
  return `${new URL(normalized).origin}/*`;
}

export function isRequiredServerOrigin(pattern: string): boolean {
  return REQUIRED_API_URLS.some((url) => serverPermissionOrigin(url) === pattern);
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}
