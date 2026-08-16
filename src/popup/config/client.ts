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
  remove(permissions: chrome.permissions.Permissions): Promise<boolean>;
}

const chromeSend: SendServerConfigCommand = (command) =>
  chrome.runtime.sendMessage(command) as Promise<ServerConfigCommandResult | undefined>;

const chromePermissions: PermissionClient = {
  request: (permissions) => chrome.permissions.request(permissions),
  remove: (permissions) => chrome.permissions.remove(permissions),
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
      let grantedForChange = false;
      if (!isRequiredServerOrigin(nextOrigin)) {
        grantedForChange = await permissions.request(permission);
        if (!grantedForChange) throw new ServerConfigClientError("permission-denied");
      }

      const current = await dispatch(send, { type: "config/server/get" });
      const currentOrigin = serverPermissionOrigin(current.apiUrl);
      try {
        const result = await dispatch(send, { type: "config/server/set", apiUrl });
        if (
          result.changed
          && currentOrigin !== null
          && currentOrigin !== nextOrigin
          && !isRequiredServerOrigin(currentOrigin)
        ) {
          await permissions.remove({ origins: [currentOrigin] }).catch(() => false);
        }
        return result;
      } catch (error) {
        if (grantedForChange) {
          await permissions.remove(permission).catch(() => false);
        }
        throw error;
      }
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
