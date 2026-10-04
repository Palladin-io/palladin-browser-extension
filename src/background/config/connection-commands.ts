import { REQUIRED_API_URLS } from '../../shared/config/server';
import type { SharedUnlockSettingsCommand, SharedUnlockSettingsResult } from '../../shared/messaging/shared-unlock-settings';
import type { SessionStatus } from '../session/types';
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
  hasAccess: (origins: string[]) => Promise<boolean>, retireSession: () => Promise<void>, setSharingPreference: (enabled: boolean) => Promise<void>,
  removeAccess: (origins: string[]) => Promise<unknown> = async () => {}): Promise<ConnectionResult> {
  await store.initialize();
  if (command.type === 'config/connections/get') return { ok: true, state: store.connections, apiUrl: store.apiUrl, changed: false };
  const next = command.type === 'config/connections/save' ? parseConnection(command.connection)
    : store.connections.connections.find(item => item.apiUrl === command.apiUrl);
  if (!next) return { ok: false, code: 'invalid-server' };
  if (!await hasAccess(connectionOrigins(next, extensionBuildTarget !== "chromium"))) return { ok: false, code: 'unavailable' };
  const previous = store.activeConnection;
  const previousConnections = store.connections.connections;
  try {
    // An OFF/name-only edit does not revoke an independently completed session.
    if (store.apiUrl !== next.apiUrl || previous?.webUrl !== next.webUrl || previous?.allowHttp !== next.allowHttp) await retireSession();
    if (previous && previous.apiUrl === next.apiUrl && previous.webUrl === next.webUrl
      && previous.sharedUnlockEnabled !== next.sharedUnlockEnabled) await setSharingPreference(next.sharedUnlockEnabled);
    const state = command.type === 'config/connections/save' ? await store.saveConnection(next) : await store.activateConnection(next.apiUrl);
    return { ok: true, state, apiUrl: store.apiUrl, changed: true };
  } finally {
    const origin = (value: string) => { const url = new URL(value); return `${url.protocol}//${url.hostname}/*`; };
    const used = new Set([...REQUIRED_API_URLS.map(origin), ...store.connections.connections.flatMap(item =>
      connectionOrigins(item, extensionBuildTarget !== "chromium").map(origin))]);
    const candidates = [next, ...previousConnections].flatMap(item => connectionOrigins(item, extensionBuildTarget !== "chromium").map(origin));
    const unused = [...new Set(candidates)].filter(value => !used.has(value));
    if (unused.length) await removeAccess(unused).catch(() => undefined);
  }
}

export async function saveConnectionSharingPreference(enabled: boolean,
  dispatch: (command: SharedUnlockSettingsCommand) => Promise<SharedUnlockSettingsResult>,
  getStatus: () => Promise<SessionStatus>): Promise<void> {
  const current = await dispatch({ type: 'shared-unlock-settings/get' });
  if (!current.ok) {
    if (current.code === 'authentication-required' && await getStatus() === 'signed-out') return;
    throw new Error('Shared unlock preference unavailable');
  }
  const saved = await dispatch({ type: 'shared-unlock-settings/set', contextId: current.contextId,
    revision: current.revision, enabled });
  if (!saved.ok) throw new Error('Shared unlock preference not saved');
}
