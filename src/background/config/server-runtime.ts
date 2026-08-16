import { env } from "./env";
import { ServerConfigStore, type LocalStorageArea } from "./server-config-store";

const storageArea: LocalStorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

export const serverConfig = new ServerConfigStore(storageArea, env.apiUrl);

let initialization: Promise<string> | null = null;

export function initializeServerConfig(): Promise<string> {
  initialization ??= serverConfig.initialize();
  return initialization;
}
