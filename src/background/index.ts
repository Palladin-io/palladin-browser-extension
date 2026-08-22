/**
 * Service worker entry point (MV3). Bootstrap only: it wires the content Port,
 * the popup command channel, the session lifecycle, and the sync + auto-lock
 * alarms. All crypto and key custody live in the session module; this file just
 * connects Chrome's events to it. Nothing security-sensitive is decided here on
 * the strength of a page-originated message — fills stay gated downstream.
 */

import { injectHostKeyFingerprint } from "@palladin/crypto";
import {
  CONTENT_PORT,
  SESSION_LIVENESS_PORT,
  isBridgeMessage,
  isInlineAutofillCommand,
  isSessionLivenessPing,
  sessionChanged,
  vaultChanged,
} from "@shared/messaging";
import {
  isRequiredServerOrigin,
  serverPermissionOrigin,
} from "@shared/config/server";
import { openSidePanel } from "@shared/browser/side-panel";

import { createAgentPairingRuntimeHandler } from "./agent/pairing-commands";
import { startNativeAgentBridge } from "./agent/bootstrap";
import {
  clearHostPairingRecord,
  saveHostPairingIntent,
  saveHostPairingRecord,
} from "./agent/pairing-store";
import {
  beginNativeAgentPairingMutation,
  connectPairedNativeAgentProvider,
  disconnectNativeAgentProvider,
  handleNativeAgentAlarm,
  readVerifiedPairing,
} from "./agent/runtime";
import { applyBadge } from "./badge";
import {
  handleServerConfigRuntimeMessage,
  isServerConfigCommand,
} from "./config/server-commands";
import { ServerOperationBarrier } from "./config/server-operation-barrier";
import { initializeServerConfig, serverConfig } from "./config/server-runtime";
import {
  handleCaptureContentRuntimeMessage,
  handleCapturePopupRuntimeMessage,
} from "./capture/runtime";
import { routePortMessage } from "./router";
import { handleRuntimeMessage } from "./session/commands";
import { SessionLivenessPublisher } from "./session/liveness";
import { ensureActiveTabSessionLiveness } from "./session/active-tab-liveness";
import { sessionAutoLock, sessionManager } from "./session/runtime";
import { registerTopFrameDocument } from "./tab-documents";
import { logger } from "./telemetry/logger";
import { isTrustedExtensionPage } from "./trusted-sender";
import { fillInlineSelectedEntry, handleVaultRuntimeMessage } from "./vault/commands";
import {
  InMemoryInlineAutofillRecency,
  handleInlineAutofillContentMessage,
  inlineAutofillSource,
} from "./vault/inline-runtime";
import { clipboardGuard, vaultCommandDeps, vaultData } from "./vault/runtime";
import {
  VaultInvalidationCoordinator,
  VaultRealtimeConnection,
} from "./vault/realtime-sync";

const SYNC_ALARM = "palladin.sync";
const SYNC_PERIOD_MINUTES = 15;
const serverOperations = new ServerOperationBarrier();
const sessionLiveness = new SessionLivenessPublisher();
const inlineAutofillRecency = new InMemoryInlineAutofillRecency();
const vaultInvalidations = new VaultInvalidationCoordinator({
  apply: (vaultId, removed) => withServerOperation(
    () => vaultData.applyRealtimeInvalidation(vaultId, removed),
  ),
  changed: () => publishSurfaceState(vaultChanged()),
});
const vaultRealtime = new VaultRealtimeConnection({
  apiUrl: () => serverConfig.apiUrl,
  accessToken: () => sessionManager.getAccessToken(),
  invalidation: (raw) => vaultInvalidations.accept(raw),
  repair: () => runServerOperation(
    () => vaultData.refresh().then(() => publishSurfaceState(vaultChanged())),
    "vault repair after realtime reconnect failed",
  ),
});
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

/** Re-read the session state and clear any stale Chromium text badge. */
function refreshBadge(): void {
  void sessionManager
    .getStatus()
    .then((status) => applyBadge(chrome.action, status))
    .catch(() => logger.warn("badge refresh failed"));
}

/**
 * Invalidate extension-owned UI and top-frame content surfaces. Lifecycle
 * events are value-free. `runtime.sendMessage` updates popup/side-panel pages;
 * the explicit tab delivery wakes already-mounted inline autofill controllers.
 */
function publishSurfaceState(event: ReturnType<typeof sessionChanged> | ReturnType<typeof vaultChanged>): void {
  void chrome.runtime.sendMessage(event).catch(() => undefined);
  void chrome.tabs.query({}).then(async (tabs) => {
    await Promise.all(tabs.map(async (tab) => {
      if (typeof tab.id !== "number") return;
      await chrome.tabs.sendMessage(tab.id, event, { frameId: 0 }).catch(() => undefined);
    }));
  }).catch(() => undefined);
}

function runServerOperation(operation: () => Promise<void>, warning: string): void {
  const lease = serverOperations.tryAcquire();
  if (lease === null) return;
  void operation()
    .catch(() => logger.warn(warning))
    .finally(() => lease.release());
}

async function withServerOperation<T>(operation: () => Promise<T>): Promise<T> {
  const lease = serverOperations.tryAcquire();
  if (lease === null) throw new Error("Server change in progress");
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

function unavailableDuringServerChange(raw: unknown): unknown {
  const type = typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)["type"]
    : null;
  if (typeof type !== "string") return null;
  if (type.startsWith("session/")) {
    return { ok: false, code: "network", message: "Server change in progress" };
  }
  if (type.startsWith("vault/")) {
    return { ok: false, code: "network", message: "Server change in progress" };
  }
  if (type.startsWith("capture/")) {
    return { ok: false, code: "unavailable", message: "Server change in progress" };
  }
  return null;
}

// Clear legacy badge text after each committed session transition.
sessionManager.hooks.onUnlocked(() => refreshBadge());
sessionManager.hooks.onLocked(() => refreshBadge());
sessionManager.hooks.onUnlocked(() => publishSurfaceState(sessionChanged("unlocked")));
sessionManager.hooks.onLocked(() => {
  void sessionManager.getStatus()
    .then((status) => publishSurfaceState(sessionChanged(status)))
    .catch(() => undefined);
});
sessionManager.hooks.onUnlocked(() => sessionLiveness.setEnabled(true));
sessionManager.hooks.onUnlocked(() => vaultRealtime.start());
sessionManager.hooks.onUnlocked(() => void ensureActiveTabSessionLiveness());
sessionManager.hooks.onLocked(() => sessionLiveness.setEnabled(false));
sessionManager.hooks.onLocked(() => {
  vaultRealtime.stop();
  vaultInvalidations.clear();
});
sessionManager.hooks.onLocked(() => inlineAutofillRecency.clear());

// Sync the vault metadata cache on unlock (plan §6 trigger). Metadata + wrapped
// keys are non-secret; this refetch never decrypts.
sessionManager.hooks.onUnlocked(() => {
  runServerOperation(
    () => vaultData.refresh().then(() => publishSurfaceState(vaultChanged())),
    "vault refresh on unlock failed",
  );
});
// On a full sign-out (not a plain lock), drop the cached metadata + wrapped keys.
sessionManager.hooks.onLocked(() => {
  runServerOperation(async () => {
    if (await sessionManager.getStatus() === "signed-out") await vaultData.clearCache();
  }, "vault cache clear on logout failed");
});

// Restore durable token/material state. Keys never survive a worker restart;
// an authenticated session therefore comes back locked, never unlocked.
void initializeServerConfig().then(() => {
  runServerOperation(async () => {
    const status = await sessionManager.initialize();
    logger.debug("session initialized", { status });
    await applyBadge(chrome.action, status);
  }, "session init failed");
});

// Agent Inject is independent of the popup lock state. The connection opens only
// after the user explicitly confirms an out-of-band host signing-key bundle.
startNativeAgentBridge();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_PORT && port.name !== SESSION_LIVENESS_PORT) return;

  sessionLiveness.register(
    port,
    async () => await sessionManager.getStatus() === "unlocked",
  );
  if (port.name === SESSION_LIVENESS_PORT) {
    port.onMessage.addListener((raw) => {
      if (isSessionLivenessPing(raw)) return;
    });
    return;
  }
  const unregisterDocument = registerTopFrameDocument(port, chrome.runtime.id);
  if (unregisterDocument !== null) port.onDisconnect.addListener(unregisterDocument);

  port.onMessage.addListener((raw) => {
    // This private, value-free ping exists only to prevent Chrome's normal
    // ~30-second MV3 idle shutdown while keys are intentionally unlocked. It
    // never calls touchActivity and never crosses into the page-facing bridge.
    if (isSessionLivenessPing(raw)) return;
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

// Top-frame isolated content scripts request value-free matching suggestions,
// then may fill one explicitly selected Entry. The browser-authenticated sender
// supplies the exact tab/document binding; page scripts cannot call this API.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isInlineAutofillCommand(raw)) return false;
  if (raw.type === "inline/open-palladin") {
    const source = inlineAutofillSource(raw, sender, chrome.runtime.id);
    if (source === null || sender.tab?.windowId === undefined) {
      sendResponse({ ok: true, kind: "surface", status: "unavailable" });
      return false;
    }
    // Invoke directly from the content-script click message so Chrome retains
    // the user activation required by sidePanel.open(). No secret is involved.
    void openSidePanel(undefined, undefined, sender.tab.windowId)
      .then((opened) => sendResponse({ ok: true, kind: "surface", status: opened ? "opened" : "unavailable" }))
      .catch(() => sendResponse({ ok: true, kind: "surface", status: "unavailable" }));
    return true;
  }
  void (async () => {
    await initializeServerConfig();
    const lease = serverOperations.tryAcquire();
    if (lease === null) {
      sendResponse({ ok: false, code: "unavailable" });
      return;
    }
    try {
      const result = await handleInlineAutofillContentMessage({
        getStatus: () => sessionManager.getStatus(),
        getMetadata: () => vaultData.getMetadata(),
        recency: inlineAutofillRecency,
        fill: async (source, vaultId, entryId, scope) => {
          await sessionManager.touchActivity();
          return fillInlineSelectedEntry(vaultCommandDeps, source, vaultId, entryId, scope);
        },
      }, raw, sender, chrome.runtime.id);
      sendResponse(result ?? { ok: false, code: "unavailable" });
    } finally {
      lease.release();
    }
  })();
  return true;
});

// Popup ↔ worker command channel. Session commands (login / unlock / lock /
// logout / settings) are tried first; anything they don't recognise is offered
// to capture and then the vault command surface.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isTrustedExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false;
  void (async () => {
    await initializeServerConfig();
    const pairingResult = await handleAgentPairingRuntimeMessage(raw);
    if (pairingResult !== null) {
      sendResponse(pairingResult);
      return;
    }

    if (isServerConfigCommand(raw)) {
      const execute = () => handleServerConfigRuntimeMessage({
        getApiUrl: () => serverConfig.apiUrl,
        hasAccess: async (apiUrl) => {
          const origin = serverPermissionOrigin(apiUrl);
          return origin !== null && chrome.permissions.contains({ origins: [origin] });
        },
        beforeChange: async () => {
          await sessionManager.logout();
          await vaultData.clearAllCache();
        },
        save: (apiUrl) => serverConfig.save(apiUrl),
        afterChange: (previousApiUrl, nextApiUrl) =>
          removeUnusedServerPermission(previousApiUrl, nextApiUrl),
        afterFailedChange: (attemptedApiUrl, activeApiUrl) =>
          removeUnusedServerPermission(attemptedApiUrl, activeApiUrl),
      }, raw);
      try {
        const result = raw.type === "config/server/set"
          ? await serverOperations.mutate(() => execute())
          : await execute();
        sendResponse(result);
      } catch {
        sendResponse({ ok: false, code: "unavailable" });
      }
      return;
    }

    const lease = serverOperations.tryAcquire();
    if (lease === null) {
      const unavailable = unavailableDuringServerChange(raw);
      if (unavailable !== null) sendResponse(unavailable);
      return;
    }
    try {
      await sessionManager.touchActivity();
      const sessionResult = await handleRuntimeMessage(sessionManager, raw);
      if (sessionResult !== null) {
        sendResponse(sessionResult);
        return;
      }
      const captureResult = handleCapturePopupRuntimeMessage(raw);
      if (captureResult !== null) {
        sendResponse(await captureResult);
        return;
      }
      const vaultResult = await handleVaultRuntimeMessage(vaultCommandDeps, raw);
      if (vaultResult !== null) {
        sendResponse(vaultResult);
        if (
          raw !== null
          && typeof raw === "object"
          && (raw as { readonly type?: unknown }).type === "vault/entry-save"
          && vaultResult.ok
          && "entrySave" in vaultResult
          && vaultResult.entrySave.status === "saved"
        ) publishSurfaceState(vaultChanged());
      }
    } finally {
      lease.release();
    }
  })();
  // Returning true keeps the message channel open for the async response.
  return true;
});

async function removeUnusedServerPermission(
  candidateApiUrl: string,
  activeApiUrl: string,
): Promise<void> {
  const candidateOrigin = serverPermissionOrigin(candidateApiUrl);
  const activeOrigin = serverPermissionOrigin(activeApiUrl);
  if (
    candidateOrigin === null
    || candidateOrigin === activeOrigin
    || isRequiredServerOrigin(candidateOrigin)
  ) return;
  await chrome.permissions.remove({ origins: [candidateOrigin] }).catch(() => false);
}

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleNativeAgentAlarm(alarm.name);
  // Idle auto-lock: the manager wipes keys when this fires.
  sessionAutoLock.dispatch(alarm.name);
  // Clipboard hygiene: wipe a copied secret once its TTL elapses.
  void clipboardGuard.handleAlarm(alarm.name);
  if (alarm.name !== SYNC_ALARM) return;
  // Periodic delta-sync trigger (plan §6): refresh the metadata cache.
  void initializeServerConfig().then(() => {
    runServerOperation(
      async () => {
        // A locked worker cannot open MemberIndex and does not need background
        // network traffic. Unlock performs an authoritative refresh itself.
        if (await sessionManager.getStatus() !== "unlocked") return;
        await vaultData.refresh();
      },
      "vault refresh on alarm failed",
    );
  });
});
