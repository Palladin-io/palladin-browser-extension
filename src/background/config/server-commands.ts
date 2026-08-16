import { normalizeServerUrl } from "@shared/config/server";

export type ServerConfigCommand =
  | { readonly type: "config/server/get" }
  | { readonly type: "config/server/set"; readonly apiUrl: string };

export type ServerConfigCommandResult =
  | { readonly ok: true; readonly apiUrl: string; readonly changed: boolean }
  | { readonly ok: false; readonly code: "invalid-server" | "unavailable" };

export interface ServerConfigCommandDeps {
  getApiUrl(): string;
  hasAccess(apiUrl: string): Promise<boolean>;
  beforeChange(): Promise<void>;
  save(apiUrl: string): Promise<string>;
  afterChange(previousApiUrl: string, nextApiUrl: string): Promise<void>;
  afterFailedChange(attemptedApiUrl: string, activeApiUrl: string): Promise<void>;
}

export function isServerConfigCommand(value: unknown): value is ServerConfigCommand {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] === "config/server/get") {
    return Object.keys(record).length === 1;
  }
  return record["type"] === "config/server/set"
    && Object.keys(record).length === 2
    && typeof record["apiUrl"] === "string";
}

export async function handleServerConfigRuntimeMessage(
  deps: ServerConfigCommandDeps,
  raw: unknown,
): Promise<ServerConfigCommandResult | null> {
  if (!isServerConfigCommand(raw)) return null;
  if (raw.type === "config/server/get") {
    return { ok: true, apiUrl: deps.getApiUrl(), changed: false };
  }

  const normalized = normalizeServerUrl(raw.apiUrl);
  if (normalized === null) return { ok: false, code: "invalid-server" };
  if (normalized === deps.getApiUrl()) {
    return { ok: true, apiUrl: normalized, changed: false };
  }

  const previousApiUrl = deps.getApiUrl();
  try {
    if (!(await deps.hasAccess(normalized))) {
      await deps.afterFailedChange(normalized, deps.getApiUrl()).catch(() => undefined);
      return { ok: false, code: "unavailable" };
    }
    await deps.beforeChange();
    const apiUrl = await deps.save(normalized);
    await deps.afterChange(previousApiUrl, apiUrl).catch(() => undefined);
    return { ok: true, apiUrl, changed: true };
  } catch {
    await deps.afterFailedChange(normalized, deps.getApiUrl()).catch(() => undefined);
    return { ok: false, code: "unavailable" };
  }
}
