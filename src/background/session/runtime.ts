/**
 * Composition root: build the one live {@link SessionManager} from the real
 * Chrome APIs. This is the only session module that reaches for `chrome`, `fetch`,
 * and `env`; everything else is pure and injected, so the whole lifecycle stays
 * unit-testable. Imported solely by the worker bootstrap — never by tests.
 */

import { serverConfig } from "../config/server-runtime";
import { AuthClient } from "./auth-client";
import { AutoLock, type AlarmScheduler } from "./auto-lock";
import { SessionManager } from "./session-manager";
import { SessionStore, type StorageArea } from "./session-store";

// Only the password-sealed session envelope and policy metadata are durable.
// Plaintext tokens and cryptographic keys remain in SessionManager memory.
const durableStorageArea: StorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

// Read access exists only to delete the old plaintext/session-only records.
const legacySessionStorageArea: StorageArea = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
};

const alarms: AlarmScheduler = {
  create: (name, info) => chrome.alarms.create(name, info),
  clear: (name) => chrome.alarms.clear(name),
};

// Forward reference: the auto-lock fire handler needs the manager, which needs
// the auto-lock instance. The closure resolves `manager` at fire time.
let manager: SessionManager;
const runtimeClientId = typeof chrome === "undefined"
  ? "palladin-browser-extension-test-client"
  : chrome.runtime.id;
export const sessionAutoLock = new AutoLock(alarms, () => {
  void manager.lock();
});

manager = new SessionManager({
  store: new SessionStore(durableStorageArea, legacySessionStorageArea),
  authClient: new AuthClient((...args) => fetch(...args), () => serverConfig.apiUrl),
  autoLock: sessionAutoLock,
  clientId: runtimeClientId,
});

export const sessionManager = manager;
