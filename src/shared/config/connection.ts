/** Public connection metadata only. No account, token or key belongs here. */
export interface Connection {
  readonly name: string;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly sharedUnlockEnabled: boolean;
  readonly allowHttp: boolean;
}

export interface ConnectionsState {
  readonly connections: readonly Connection[];
  readonly activeApiUrl: string | null;
}

export function normalizeConnectionUrl(input: string): string | null {
  try {
    if (input.length > 2048 || /[\\\s]/.test(input.trim())) return null;
    const url = new URL(input.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || input.includes('*')) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

export function parseConnection(value: unknown): Connection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'allowHttp,apiUrl,name,sharedUnlockEnabled,webUrl'
    || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80
    || typeof row.apiUrl !== 'string' || typeof row.webUrl !== 'string'
    || typeof row.allowHttp !== 'boolean' || typeof row.sharedUnlockEnabled !== 'boolean') return null;
  const apiUrl = normalizeConnectionUrl(row.apiUrl);
  const webUrl = normalizeConnectionUrl(row.webUrl);
  if (!apiUrl || !webUrl || (!row.allowHttp && (apiUrl.startsWith('http:') || webUrl.startsWith('http:')))) return null;
  return Object.freeze({ name: row.name.trim(), apiUrl, webUrl, allowHttp: row.allowHttp, sharedUnlockEnabled: row.sharedUnlockEnabled });
}

export function connectionOrigins(connection: Connection, includePanel = true): string[] {
  return [...new Set((includePanel ? [connection.apiUrl, connection.webUrl] : [connection.apiUrl]).map(url => new URL(url).origin + '/*'))];
}
