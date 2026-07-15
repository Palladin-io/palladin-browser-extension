/**
 * Composition root: build the one live {@link SessionManager} from the real
 * Chrome APIs. This is the only session module that reaches for `chrome`, `fetch`,
 * and `env`; everything else is pure and injected, so the whole lifecycle stays
 * unit-testable. Imported solely by the worker bootstrap — never by tests.
 */

import { env } from "../config/env";
import { AuthClient } from "./auth-client";
import { AutoLock, type AlarmScheduler } from "./auto-lock";
import { SessionManager } from "./session-manager";
import { SessionStore, type StorageArea } from "./session-store";

// Keys live EXCLUSIVELY in chrome.storage.session (memory-backed, cleared on
// browser close). This adapter is the concrete binding behind SessionStore.
const storageArea: StorageArea = {
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
export const sessionAutoLock = new AutoLock(alarms, () => {
  void manager.lock();
});

manager = new SessionManager({
  store: new SessionStore(storageArea),
  authClient: new AuthClient((...args) => fetch(...args), env.apiUrl),
  autoLock: sessionAutoLock,
});

export const sessionManager = manager;
