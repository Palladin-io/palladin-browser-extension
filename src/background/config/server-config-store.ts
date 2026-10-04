import { parseConnection, type Connection, type ConnectionsState } from "../../shared/config/connection";
import { normalizeServerUrl } from "@shared/config/server";

export const CONNECTIONS_CONFIG_KEY = "palladin.server.connections.v1";

export const SERVER_CONFIG_KEY = "palladin.server.apiUrl";

export interface LocalStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class ServerConfigStore {
  private currentApiUrl: string;
  private initialized = false;
  private state: ConnectionsState = { connections: [], activeApiUrl: null };

  get connections(): ConnectionsState { return this.state; }
  get activeConnection(): Connection | undefined { return this.state.connections.find(item => item.apiUrl === this.state.activeApiUrl); }
  get sharedUnlockEnvironments() {
    const active = this.activeConnection;
    return active?.sharedUnlockEnabled ? [{ apiUrl: active.apiUrl, webOrigin: new URL(active.webUrl).origin }] : [];
  }

  constructor(
    private readonly storage: LocalStorageArea,
    fallbackApiUrl: string,
  ) {
    const normalized = normalizeServerUrl(fallbackApiUrl);
    if (normalized === null) throw new Error("Invalid packaged server URL");
    this.currentApiUrl = normalized;
  }

  get networkApiUrl(): string {
    this.assertNetworkAllowed();
    return this.currentApiUrl;
  }

  assertNetworkAllowed(): void {
    if (this.currentApiUrl.startsWith('http:') && this.activeConnection?.allowHttp !== true) {
      throw new Error('HTTP requires consent for the active connection');
    }
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
    const connections = await this.storage.get(CONNECTIONS_CONFIG_KEY);
    const parsed = parseState(connections[CONNECTIONS_CONFIG_KEY]);
    if (parsed) {
      this.state = parsed;
      if (this.activeConnection) this.currentApiUrl = this.activeConnection.apiUrl;
    }
    this.initialized = true;
    return this.currentApiUrl;
  }

  async save(apiUrl: string): Promise<string> {
    const normalized = normalizeServerUrl(apiUrl);
    if (normalized === null) throw new Error("Invalid server URL");
    await this.storage.set({ [SERVER_CONFIG_KEY]: normalized, [CONNECTIONS_CONFIG_KEY]: { ...this.state, activeApiUrl: null } });
    this.state = { ...this.state, activeApiUrl: null };
    this.currentApiUrl = normalized;
    this.initialized = true;
    return normalized;
  }

  async saveConnection(input: Connection): Promise<ConnectionsState> {
    const connection = parseConnection(input);
    if (!connection) throw new Error("Invalid connection");
    await this.initialize();
    const existing = this.state.connections.filter(item => item.apiUrl !== connection.apiUrl);
    if (existing.length >= 16) throw new Error("Too many connections");
    return this.commitConnections({ connections: [...existing, connection], activeApiUrl: connection.apiUrl });
  }

  async activateConnection(apiUrl: string): Promise<ConnectionsState> {
    await this.initialize();
    if (!this.state.connections.some(item => item.apiUrl === apiUrl)) throw new Error("Unknown connection");
    return this.commitConnections({ ...this.state, activeApiUrl: apiUrl });
  }

  private async commitConnections(state: ConnectionsState): Promise<ConnectionsState> {
    await this.storage.set({ [CONNECTIONS_CONFIG_KEY]: state });
    this.state = Object.freeze({ ...state, connections: Object.freeze([...state.connections]) });
    this.currentApiUrl = this.activeConnection!.apiUrl;
    return this.state;
  }

}

function parseState(value: unknown): ConnectionsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'activeApiUrl,connections' || !Array.isArray(row.connections) || row.connections.length > 16) return null;
  const connections = row.connections.map(parseConnection);
  if (connections.some(item => !item) || new Set(connections.map(item => item!.apiUrl)).size !== connections.length
    || (row.activeApiUrl !== null && !connections.some(item => item!.apiUrl === row.activeApiUrl))) return null;
  return Object.freeze({ connections: Object.freeze(connections as Connection[]), activeApiUrl: row.activeApiUrl as string | null });
}
