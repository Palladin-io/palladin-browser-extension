import { SharedUnlockPreferenceGate } from "../shared-unlock/preference-gate";
import { sharedUnlockPreferences } from '../shared-unlock/preference-state-runtime';
import { recordExtensionOwnPolicy } from "../shared-unlock/own-policy-runtime";
import { recordExtensionOwnActivity } from "../shared-unlock/own-activity-runtime";
import { OwnSharedUnlockActivityRecorder } from "../shared-unlock/own-activity";
import { persistManualSharedUnlockDeadline } from "../shared-unlock/manual-checkpoint";
/**
 * Composition root: build the one live {@link SessionManager} from the real
 * Chrome APIs. This is the only session module that reaches for `chrome`, `fetch`,
 * and `env`; everything else is pure and injected, so the whole lifecycle stays
 * unit-testable. Imported solely by the worker bootstrap — never by tests.
 */

import { SharedUnlockExpiryStore } from "../shared-unlock/expiry-store";
import { serverConfig } from "../config/server-runtime";
import { AuthClient } from "./auth-client";
import { AutoLock, type AlarmScheduler } from "./auto-lock";
import { SessionManager } from "./session-manager";
import { deliverSharedUnlockClosings, flushSharedUnlockClosings } from "../shared-unlock/closing";
import { SharedUnlockApi } from "../shared-unlock/api";
import { SharedUnlockLinkStore } from "../shared-unlock/link-store";
import { SharedUnlockSourceAuthority } from "../shared-unlock/source-authority";
import { readManualLockCheckpoint, type SharedUnlockManualLockCheckpoint } from '../shared-unlock/manual-lock-checkpoint';
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

export const sharedUnlockExpiry = new SharedUnlockExpiryStore(durableStorageArea);
export const sharedUnlockLinks = new SharedUnlockLinkStore(durableStorageArea);
export const sharedUnlockPreferenceGate = new SharedUnlockPreferenceGate(durableStorageArea);

const sharingApi = new SharedUnlockApi((...args) => fetch(...args), () => serverConfig.apiUrl);
const linkScopes = (accountId: string, apiUrl: string) => __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__
  .filter(environment => environment.apiUrl === apiUrl)
  .map(environment => ({ ...environment, accountId, extensionId: runtimeClientId }));
export const sharedUnlockSource = new SharedUnlockSourceAuthority(sharingApi, Date.now,
  async (session, signal, check) => {
    if (!await sharedUnlockPreferenceGate.isAllowed({ accountId: session.userId, apiUrl: session.apiUrl })) return;
    const checkpoints: SharedUnlockManualLockCheckpoint[] = [];
    for (const scope of linkScopes(session.userId, session.apiUrl)) {
      await flushSharedUnlockClosings(scope, session, sharedUnlockLinks, sharingApi, signal, () => { check(); sharedUnlockPreferenceGate.assertAllowed(scope); });
      checkpoints.push(...await readManualLockCheckpoint(scope, session, sharedUnlockLinks, sharingApi, signal, check));
    }
    return checkpoints;
  }, (root, session) => {
    const scope = { accountId: session.userId, apiUrl: session.apiUrl };
    sharedUnlockExpiry.remember(scope, root.sequence);
    return sharedUnlockExpiry.checkpoint(scope, root.sequence, Math.min(root.idleDeadlineMs, root.absoluteDeadlineMs, root.offlineDeadlineMs), Math.min(root.absoluteDeadlineMs, root.offlineDeadlineMs));
  });

const activityRecorder = new OwnSharedUnlockActivityRecorder(sharingApi, sharedUnlockExpiry);

manager = new SessionManager({
  store: new SessionStore(durableStorageArea, legacySessionStorageArea),
  authClient: new AuthClient((...args) => fetch(...args), () => serverConfig.apiUrl),
  autoLock: sessionAutoLock,
  clientId: runtimeClientId,
  onOwnActivity: () => recordExtensionOwnActivity(manager, sharedUnlockSource, activityRecorder),
  onOwnPolicyChanged: () => recordExtensionOwnPolicy(manager, sharedUnlockSource, sharedUnlockExpiry),
  retireSharedUnlock: scope => sharedUnlockExpiry.retire({ accountId: scope.userId, apiUrl: scope.apiUrl }),
  prepareManualUnlock: async context => {
    const root = await sharedUnlockSource.prepare(context);
    if (!root) return null;
    return { ...root, checkpoint: deadlineMs => persistManualSharedUnlockDeadline(
      { accountId: context.tokens.userId, apiUrl: context.tokens.apiUrl }, root.sequence,
      deadlineMs, sharedUnlockExpiry, context.assertCurrent, () => {
        if (sharedUnlockSource.snapshot().authorization?.authorizationId === root.authorizationId) sharedUnlockSource.reset();
      }, Math.min(root.absoluteDeadlineMs, root.offlineDeadlineMs)) };
  },
  deliverManualClosing: async (session, check) => {
    if (!await sharedUnlockPreferenceGate.isAllowed({ accountId: session.userId, apiUrl: session.apiUrl })) return;
    check();
    await deliverSharedUnlockClosings(linkScopes(session.userId, session.apiUrl), session, sharedUnlockLinks, sharingApi,
      () => { check(); sharedUnlockPreferenceGate.assertAllowed({ accountId: session.userId, apiUrl: session.apiUrl }); });
  },
  recordManualClosing: async (accountId, action) => {
    if (!await sharedUnlockPreferenceGate.isAllowed({ accountId, apiUrl: serverConfig.apiUrl })) return;
    const scopes = linkScopes(accountId, serverConfig.apiUrl);
    const results = await Promise.allSettled(scopes.map(scope => sharedUnlockLinks.recordManualClosing(scope, action)));
    if (results.some(result => result.status === "rejected")) throw new Error("Shared unlock closing could not be saved");
  },
});

manager.hooks.onLocked(() => sharedUnlockSource.reset());
manager.hooks.onLocked(() => sharedUnlockPreferences.clear());
manager.hooks.onUnlocked(() => sharedUnlockPreferences.clear());

export const sessionManager = manager;
