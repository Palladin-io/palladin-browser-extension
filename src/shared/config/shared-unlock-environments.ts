import { normalizeServerUrl } from "./server";

/** Public deployment configuration, independent of any page message or deep link. */
export interface SharedUnlockEnvironment {
  readonly apiUrl: string;
  readonly webOrigin: string;
}

export function parseSharedUnlockEnvironments(raw: string | undefined): readonly SharedUnlockEnvironment[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid shared unlock environment configuration"); }
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid shared unlock environment configuration");
  const apiUrls = new Set<string>();
  const webOrigins = new Set<string>();
  return Object.freeze(value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid shared unlock environment configuration");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "apiUrl,webOrigin" || typeof row.apiUrl !== "string"
      || typeof row.webOrigin !== "string" || row.apiUrl.length > 2048 || row.webOrigin.length > 2048) {
      throw new Error("Invalid shared unlock environment configuration");
    }
    const apiUrl = normalizeServerUrl(row.apiUrl);
    const webOrigin = normalizeServerUrl(row.webOrigin);
    if (!apiUrl || !webOrigin || new URL(webOrigin).origin !== webOrigin
      || row.apiUrl.includes("*") || row.webOrigin.includes("*")
      || apiUrls.has(apiUrl) || webOrigins.has(webOrigin)) throw new Error("Invalid shared unlock environment configuration");
    apiUrls.add(apiUrl); webOrigins.add(webOrigin);
    return Object.freeze({ apiUrl, webOrigin });
  }));
}

/** Match patterns are coarse host routing. The runtime also checks the exact port/origin. */
export function sharedUnlockWebMatches(environments: readonly SharedUnlockEnvironment[]): string[] {
  return [...new Set(environments.map(({ webOrigin }) => {
    const url = new URL(webOrigin);
    return `${url.protocol}//${url.hostname}/*`;
  }))];
}
