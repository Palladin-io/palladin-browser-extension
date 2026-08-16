import { normalizeServerUrl } from "@shared/config/server";

export const SERVER_CONFIG_KEY = "palladin.server.apiUrl";

export interface LocalStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class ServerConfigStore {
  private currentApiUrl: string;
  private initialized = false;

  constructor(
    private readonly storage: LocalStorageArea,
    fallbackApiUrl: string,
  ) {
    const normalized = normalizeServerUrl(fallbackApiUrl);
    if (normalized === null) throw new Error("Invalid packaged server URL");
    this.currentApiUrl = normalized;
  }

  get apiUrl(): string {
    return this.currentApiUrl;
  }

  async initialize(): Promise<string> {
    if (this.initialized) return this.currentApiUrl;
    const stored = await this.storage.get(SERVER_CONFIG_KEY);
    const candidate = stored[SERVER_CONFIG_KEY];
    const normalized = typeof candidate === "string" ? normalizeServerUrl(candidate) : null;
    if (normalized !== null) {
      this.currentApiUrl = normalized;
    } else if (candidate !== undefined) {
      await this.storage.remove(SERVER_CONFIG_KEY);
    }
    this.initialized = true;
    return this.currentApiUrl;
  }

  async save(apiUrl: string): Promise<string> {
    const normalized = normalizeServerUrl(apiUrl);
    if (normalized === null) throw new Error("Invalid server URL");
    await this.storage.set({ [SERVER_CONFIG_KEY]: normalized });
    this.currentApiUrl = normalized;
    this.initialized = true;
    return normalized;
  }
}
