import { extensionBuildTarget } from "@shared/config/build-target";
import { parseConnection, connectionOrigins, type Connection } from "@shared/config/connection";
import type { ConnectionCommand, ConnectionResult } from "../../background/config/connection-commands";
import type {
  ServerConfigCommand,
  ServerConfigCommandResult,
} from "../../background/config/server-commands";
import {
  isRequiredServerOrigin,
  normalizeServerUrl,
  serverPermissionOrigin,
} from "@shared/config/server";

export type ServerConfigClientErrorCode =
  | "invalid-server"
  | "permission-denied"
  | "unavailable";

export class ServerConfigClientError extends Error {
  constructor(readonly code: ServerConfigClientErrorCode) {
    super(code);
    this.name = "ServerConfigClientError";
  }
}

export interface ServerConfigStatus {
  readonly apiUrl: string;
  readonly changed: boolean;
}

export interface ServerConfigClient {
  get(): Promise<ServerConfigStatus>;
  save(apiUrl: string): Promise<ServerConfigStatus>;
}

export type SendServerConfigCommand = (
  command: ServerConfigCommand,
) => Promise<ServerConfigCommandResult | undefined>;

export interface PermissionClient {
  request(permissions: chrome.permissions.Permissions): Promise<boolean>;
}

const chromeSend: SendServerConfigCommand = (command) =>
  chrome.runtime.sendMessage(command) as Promise<ServerConfigCommandResult | undefined>;

const chromePermissions: PermissionClient = {
  request: (permissions) => chrome.permissions.request(permissions),
};

export function createServerConfigClient(
  send: SendServerConfigCommand = chromeSend,
  permissions: PermissionClient = chromePermissions,
): ServerConfigClient {
  return {
    async get() {
      return dispatch(send, { type: "config/server/get" });
    },
    async save(input) {
      const apiUrl = normalizeServerUrl(input);
      const nextOrigin = apiUrl === null ? null : serverPermissionOrigin(apiUrl);
      if (apiUrl === null || nextOrigin === null) {
        throw new ServerConfigClientError("invalid-server");
      }

      const permission = { origins: [nextOrigin] };
      if (!isRequiredServerOrigin(nextOrigin)) {
        const granted = await permissions.request(permission);
        if (!granted) throw new ServerConfigClientError("permission-denied");
      }

      return dispatch(send, { type: "config/server/set", apiUrl });
    },
  };
}

async function dispatch(
  send: SendServerConfigCommand,
  command: ServerConfigCommand,
): Promise<ServerConfigStatus> {
  const result = await send(command);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new ServerConfigClientError("unavailable");
  }
  if (!result.ok) throw new ServerConfigClientError(result.code);
  return { apiUrl: result.apiUrl, changed: result.changed };
}

export interface ConnectionClient {
  get(): Promise<Extract<ConnectionResult, { ok: true }>>;
  save(connection: Connection): Promise<Extract<ConnectionResult, { ok: true }>>;
}
export function createConnectionClient(
  send: (command: ConnectionCommand) => Promise<ConnectionResult | undefined> = command => chrome.runtime.sendMessage(command),
  permissions: PermissionClient = chromePermissions,
): ConnectionClient {
  const dispatch = async (command: ConnectionCommand) => {
    const result = await send(command);
    if (!result?.ok) throw new ServerConfigClientError(result?.code ?? 'unavailable');
    return result;
  };
  return {
    get: () => dispatch({ type: 'config/connections/get' }),
    async save(input) {
      const connection = parseConnection(input);
      if (!connection) throw new ServerConfigClientError('invalid-server');
      if (!await permissions.request({ origins: connectionOrigins(connection, extensionBuildTarget !== "chromium") })) throw new ServerConfigClientError('permission-denied');
      return dispatch({ type: 'config/connections/save', connection });
    },
  };
}
