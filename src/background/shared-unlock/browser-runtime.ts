import { randomBytes, toBase64Url, wipe } from "@palladin/crypto";
import { serverConfig } from "../config/server-runtime";
import { sessionManager, sharedUnlockLinks, sharedUnlockSource, sharedUnlockExpiry, sharedUnlockPreferenceGate } from "../session/runtime";
import { startSharedUnlockLinkMonitor } from "./link-monitor";
import { SharedUnlockApi } from "./api";
import { startSharedUnlockBrowserCoordinator } from "./browser-coordinator";
import type { ChromiumSharedUnlockRoute } from "./chromium-route";
import { prepareSharedUnlockLink } from "./prepare-link";
import { beginSharedUnlockSource } from "./source";
import { beginSharedUnlockReceiver } from "./receiver";

/** Worker-only composition. Browser messages never gain a SessionManager or
 * storage handle; the coordinator only receives scoped nonsensitive metadata. */
export function coordinateSharedUnlockBrowser(route: ChromiumSharedUnlockRoute) {
  const api = new SharedUnlockApi((...args) => fetch(...args), () => serverConfig.apiUrl);
  const scope = (accountId: string) => ({ accountId, apiUrl: route.apiUrl, webOrigin: route.webOrigin, extensionId: route.extensionId });
  const admissible = async (accountId: string, linkId?: string) => {
    route.assertCurrent();
    if (!await sharedUnlockPreferenceGate.isAllowed(scope(accountId))) throw new Error("Shared unlock is locally paused");
    route.assertCurrent();
    const marker = await sharedUnlockLinks.ensure(scope(accountId));
    route.assertCurrent();
    if ((linkId && marker.linkId !== linkId) || marker.pending.length || marker.disconnectId || marker.observed?.state === "revoked") {
      throw new Error("Shared unlock local link unavailable");
    }
    return marker;
  };
  const nonce = async () => { const bytes = await randomBytes(32); try { return toBase64Url(bytes); } finally { wipe(bytes); } };
  const subscribe = (changed: () => void) => {
    const listeners = [sessionManager.hooks.onLocked(changed), sessionManager.hooks.onUnlocked(changed), sharedUnlockSource.subscribe(changed)];
    return () => { for (const remove of listeners) remove(); };
  };
  const monitor = startSharedUnlockLinkMonitor(route, {
    nonce, subscribe,
    capture: () => {
      const root = sharedUnlockSource.closingWitness();
      if (!root) return null;
      const captured = sessionManager.captureSharedUnlockSource();
      try {
        const session = captured.read().tokens;
        return { session, sequence: root.sequence, signal: captured.signal, dispose: () => captured.dispose(),
          assertCurrent: () => {
            captured.read();
            const current = sharedUnlockSource.closingWitness();
            if (current?.authorizationId !== root.authorizationId || current.sourceGeneration !== root.sourceGeneration) throw new Error("Shared link own root changed");
          } };
      } catch (error) { captured.dispose(); throw error; }
    },
    closeSession: action => action === "logout" ? sessionManager.logout() : sessionManager.lock(),
  }, sharedUnlockLinks, api);
  const coordinator = startSharedUnlockBrowserCoordinator(route, {
    role: "extension",
    nonce,
    readState: async () => {
      const accountId = await sessionManager.getUserId();
      const status = await sessionManager.getStatus();
      const state = sharedUnlockSource.snapshot();
      const source = status === "unlocked" && accountId && await sharedUnlockPreferenceGate.isAllowed(scope(accountId)) && state.authorization?.accountId === accountId
        && state.sourceGeneration && state.preference?.sharedUnlockEnabled
        ? { organizationId: state.authorization.organizationId, generation: state.sourceGeneration } : null;
      return { accountId, status, source };
    },
    subscribe,
    selectLink: async (accountId, proposed) => (await admissible(accountId, proposed)).linkId,
    prepareSource: async (accountId, organizationId, linkId, signal, assertAttempt) => {
      const assertCurrent = () => { assertAttempt(); sharedUnlockPreferenceGate.assertAllowed(scope(accountId)); };
      await admissible(accountId, linkId); assertCurrent();
      const result = await prepareSharedUnlockLink({ scope: scope(accountId), organizationId, signal,
        verifyBrowser: () => route.verifyCurrent(), assertCurrent }, sessionManager, sharedUnlockSource, api, sharedUnlockLinks);
      assertCurrent(); if (result.link.linkId !== linkId) throw new Error("Shared unlock local link changed");
      return { linkEpoch: result.link.epoch, preferenceRevision: result.preference.revision };
    },
    checkReceiver: async (binding, signal) => {
      const marker = await admissible(binding.accountId, binding.linkId);
      if (signal.aborted || (marker.observed && binding.linkEpoch < marker.observed.epoch)) throw new Error("Shared unlock receiver selection expired");
    },
    source: (binding, signal, assertCurrent) => beginSharedUnlockSource({ apiUrl: route.apiUrl, binding, signal,
      assertCurrent: () => { assertCurrent(); sharedUnlockPreferenceGate.assertAllowed(scope(binding.accountId)); } }, sessionManager, sharedUnlockSource, api),
    receiver: (binding, signal, assertCurrent) => beginSharedUnlockReceiver({ apiUrl: route.apiUrl, binding, signal,
      assertCurrent: () => { assertCurrent(); sharedUnlockPreferenceGate.assertAllowed(scope(binding.accountId)); },
      assertFreshAuthorization: (sequence, deadlineMs, hardDeadlineMs) => sharedUnlockExpiry.checkpoint(scope(binding.accountId), sequence, deadlineMs, hardDeadlineMs) }, sessionManager, api,
      (authorization, generation, assertOwnCurrent) => {
        assertOwnCurrent();
        sharedUnlockExpiry.remember(scope(binding.accountId), authorization.sequence);
        sharedUnlockSource.adopt(authorization, generation,
        { sharedUnlockEnabled: true, revision: binding.preferenceRevision }, () => {
          assertOwnCurrent(); if (serverConfig.apiUrl !== route.apiUrl) throw new Error("Shared unlock own environment changed");
        }); }),
  });
  const unsubscribeGate = sharedUnlockPreferenceGate.subscribe(changed => {
    if (changed.apiUrl === route.apiUrl) coordinator.cancelPending(changed.accountId);
  });
  return { close: () => { unsubscribeGate(); coordinator.close(); monitor.close(); } };
}
