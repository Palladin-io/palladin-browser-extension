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
import { SharedUnlockApi } from "../shared-unlock/api";
import { SharedUnlockLinkStore } from "../shared-unlock/link-store";
import { SharedUnlockSourceAuthority } from "../shared-unlock/source-authority";
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

export const sharedUnlockLinks = new SharedUnlockLinkStore(durableStorageArea);

export const sharedUnlockSource = new SharedUnlockSourceAuthority(
  new SharedUnlockApi((...args) => fetch(...args), () => serverConfig.apiUrl),
);

manager = new SessionManager({
  store: new SessionStore(durableStorageArea, legacySessionStorageArea),
  authClient: new AuthClient((...args) => fetch(...args), () => serverConfig.apiUrl),
  autoLock: sessionAutoLock,
  clientId: runtimeClientId,
  prepareManualUnlock: context => sharedUnlockSource.prepare(context),
  recordManualClosing: async (accountId, action) => {
    const scopes = __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__
      .filter(environment => environment.apiUrl === serverConfig.apiUrl)
      .map(environment => ({ ...environment, accountId, extensionId: runtimeClientId }));
    const results = await Promise.allSettled(scopes.map(scope => sharedUnlockLinks.recordManualClosing(scope, action)));
    if (results.some(result => result.status === "rejected")) throw new Error("Shared unlock closing could not be saved");
  },
});

manager.hooks.onLocked(() => sharedUnlockSource.reset());

export const sessionManager = manager;
