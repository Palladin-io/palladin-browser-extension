/**
 * Service worker entry point (MV3). Bootstrap only: it wires the content Port,
 * the popup command channel, the session lifecycle, and the sync + auto-lock
 * alarms. All crypto and key custody live in the session module; this file just
 * connects Chrome's events to it. Nothing security-sensitive is decided here on
 * the strength of a page-originated message — fills stay gated downstream.
 */

import { injectHostKeyFingerprint } from "@palladin/crypto";
import { CONTENT_PORT, isBridgeMessage } from "@shared/messaging";
import { serverPermissionOrigin } from "@shared/config/server";

import { createAgentPairingRuntimeHandler } from "./agent/pairing-commands";
import {
  clearHostPairingRecord,
  saveHostPairingIntent,
  saveHostPairingRecord,
} from "./agent/pairing-store";
import {
  beginNativeAgentPairingMutation,
  connectNativeAgentProvider,
  connectPairedNativeAgentProvider,
  disconnectNativeAgentProvider,
  handleNativeAgentAlarm,
  readVerifiedPairing,
} from "./agent/runtime";
import { applyBadge } from "./badge";
import { handleServerConfigRuntimeMessage } from "./config/server-commands";
import { initializeServerConfig, serverConfig } from "./config/server-runtime";
import {
  handleCaptureContentRuntimeMessage,
  handleCapturePopupRuntimeMessage,
} from "./capture/runtime";
import { routePortMessage } from "./router";
import { handleRuntimeMessage } from "./session/commands";
import { sessionAutoLock, sessionManager } from "./session/runtime";
import { registerTopFrameDocument } from "./tab-documents";
import { logger } from "./telemetry/logger";
import { isTrustedExtensionPage } from "./trusted-sender";
import { handleVaultRuntimeMessage } from "./vault/commands";
import { clipboardGuard, vaultCommandDeps, vaultData } from "./vault/runtime";

const SYNC_ALARM = "palladin.sync";
const handleAgentPairingRuntimeMessage = createAgentPairingRuntimeHandler({
  readVerifiedPairing,
  deriveFingerprint: injectHostKeyFingerprint,
  createIntentToken: () => crypto.randomUUID(),
  beginMutation: beginNativeAgentPairingMutation,
  savePairingIntent: saveHostPairingIntent,
  savePairing: saveHostPairingRecord,
  clearPairing: clearHostPairingRecord,
  connect: connectPairedNativeAgentProvider,
  disconnect: disconnectNativeAgentProvider,
});

/** Re-read the session state and repaint the toolbar padlock badge. */
function refreshBadge(): void {
  void sessionManager
    .getStatus()
    .then((status) => applyBadge(chrome.action, status))
    .catch(() => logger.warn("badge refresh failed"));
}

// Keep the badge in lockstep with the session: unlock clears the padlock,
// lock/logout restores it. (`onLocked` fires for both an explicit lock and a
// logout — refreshBadge re-reads the actual status either way.)
sessionManager.hooks.onUnlocked(() => refreshBadge());
sessionManager.hooks.onLocked(() => refreshBadge());

// Sync the vault metadata cache on unlock (plan §6 trigger). Metadata + wrapped
// keys are non-secret; this refetch never decrypts.
sessionManager.hooks.onUnlocked(() => {
  void vaultData.refresh().catch(() => logger.warn("vault refresh on unlock failed"));
});
// On a full sign-out (not a plain lock), drop the cached metadata + wrapped keys.
sessionManager.hooks.onLocked(() => {
  void sessionManager.getStatus().then((status) => {
    if (status === "signed-out") return vaultData.clearCache();
  });
});

// Rehydrate any session that survived a worker restart in chrome.storage.session
// (an already-unlocked session comes back unlocked, no re-derive).
void initializeServerConfig()
  .then(() => sessionManager.initialize())
  .then((status) => {
    logger.debug("session initialized", { status });
    void applyBadge(chrome.action, status);
  })
  .catch(() => logger.warn("session init failed"));

// Agent Inject is independent of the popup lock state. The connection opens only
// after the user explicitly confirms an out-of-band host signing-key bundle.
connectNativeAgentProvider();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_PORT) return;

  const unregisterDocument = registerTopFrameDocument(port, chrome.runtime.id);
  if (unregisterDocument !== null) port.onDisconnect.addListener(unregisterDocument);

  port.onMessage.addListener((raw) => {
    // The Port is isolated from the page, but the content script forwards
    // page-adjacent traffic — validate the shape before acting.
    if (!isBridgeMessage(raw)) return;
    const reply = routePortMessage(raw);
    if (reply) port.postMessage(reply);
  });
});

// Content scripts may report only a shape-only, top-frame new-password
// candidate. This listener has a separate sender gate from the popup channel.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const result = handleCaptureContentRuntimeMessage(raw, sender, chrome.runtime.id);
  if (result === null) return false;
  sendResponse(result);
  return false;
});

// Popup ↔ worker command channel. Session commands (login / unlock / lock /
// logout / settings) are tried first; anything they don't recognise is offered
// to capture and then the vault command surface.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isTrustedExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false;
  void (async () => {
    await initializeServerConfig();
    await sessionManager.touchActivity();
    const sessionResult = await handleRuntimeMessage(sessionManager, raw);
    if (sessionResult !== null) {
      sendResponse(sessionResult);
      return;
    }
    const pairingResult = await handleAgentPairingRuntimeMessage(raw);
    if (pairingResult !== null) {
      sendResponse(pairingResult);
      return;
    }
    const serverConfigResult = await handleServerConfigRuntimeMessage({
      getApiUrl: () => serverConfig.apiUrl,
      hasAccess: async (apiUrl) => {
        const origin = serverPermissionOrigin(apiUrl);
        return origin !== null && chrome.permissions.contains({ origins: [origin] });
      },
      beforeChange: async () => {
        await sessionManager.logout();
        await vaultData.clearCache();
      },
      save: (apiUrl) => serverConfig.save(apiUrl),
    }, raw);
    if (serverConfigResult !== null) {
      sendResponse(serverConfigResult);
      return;
    }
    const captureResult = handleCapturePopupRuntimeMessage(raw);
    if (captureResult !== null) {
      sendResponse(await captureResult);
      return;
    }
    const vaultResult = await handleVaultRuntimeMessage(vaultCommandDeps, raw);
    if (vaultResult !== null) sendResponse(vaultResult);
  })();
  // Returning true keeps the message channel open for the async response.
  return true;
});

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  // ~5 min cadence for the future delta-sync trigger (see the sync plan).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleNativeAgentAlarm(alarm.name);
  // Idle auto-lock: the manager wipes keys when this fires.
  sessionAutoLock.dispatch(alarm.name);
  // Clipboard hygiene: wipe a copied secret once its TTL elapses.
  void clipboardGuard.handleAlarm(alarm.name);
  if (alarm.name !== SYNC_ALARM) return;
  // Periodic delta-sync trigger (plan §6): refresh the metadata cache.
  void initializeServerConfig()
    .then(() => vaultData.refresh())
    .catch(() => logger.warn("vault refresh on alarm failed"));
});
