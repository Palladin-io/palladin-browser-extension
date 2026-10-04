import { extensionBuildTarget } from "../../shared/config/build-target";
import { connectionOrigins, parseConnection, type Connection, type ConnectionsState } from '../../shared/config/connection';
import type { ServerConfigStore } from './server-config-store';

export type ConnectionCommand = { type: 'config/connections/get' }
  | { type: 'config/connections/save'; connection: Connection }
  | { type: 'config/connections/activate'; apiUrl: string };
export type ConnectionResult = { ok: true; state: ConnectionsState; apiUrl: string; changed: boolean }
  | { ok: false; code: 'invalid-server' | 'unavailable' };

export function isConnectionCommand(value: unknown): value is ConnectionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.type === 'config/connections/get' && Object.keys(row).length === 1)
    || (row.type === 'config/connections/save' && Object.keys(row).length === 2 && parseConnection(row.connection) !== null)
    || (row.type === 'config/connections/activate' && Object.keys(row).length === 2 && typeof row.apiUrl === 'string' && row.apiUrl.length <= 2048);
}

export async function handleConnectionCommand(store: ServerConfigStore, command: ConnectionCommand,
  hasAccess: (origins: string[]) => Promise<boolean>, retireSession: () => Promise<void>, setSharingPreference: (enabled: boolean) => Promise<void>): Promise<ConnectionResult> {
  await store.initialize();
  if (command.type === 'config/connections/get') return { ok: true, state: store.connections, apiUrl: store.apiUrl, changed: false };
  const next = command.type === 'config/connections/save' ? parseConnection(command.connection)
    : store.connections.connections.find(item => item.apiUrl === command.apiUrl);
  if (!next) return { ok: false, code: 'invalid-server' };
  if (!await hasAccess(connectionOrigins(next, extensionBuildTarget !== "chromium"))) return { ok: false, code: 'unavailable' };
  const previous = store.activeConnection;
  // An OFF/name-only edit does not revoke an independently completed session.
  if (store.apiUrl !== next.apiUrl || previous?.webUrl !== next.webUrl || previous?.allowHttp !== next.allowHttp) await retireSession();
  if (previous && previous.apiUrl === next.apiUrl && previous.webUrl === next.webUrl
    && previous.sharedUnlockEnabled !== next.sharedUnlockEnabled) await setSharingPreference(next.sharedUnlockEnabled);
  const state = command.type === 'config/connections/save' ? await store.saveConnection(next) : await store.activateConnection(next.apiUrl);
  return { ok: true, state, apiUrl: store.apiUrl, changed: true };
}
