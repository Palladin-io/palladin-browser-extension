/**
 * Service worker entry point (MV3). Bootstrap only: it wires the content Port,
 * the popup command channel, the session lifecycle, and the sync + auto-lock
 * alarms. All crypto and key custody live in the session module; this file just
 * connects Chrome's events to it. Nothing security-sensitive is decided here on
 * the strength of a page-originated message — fills stay gated downstream.
 */

import { CONTENT_PORT, isBridgeMessage } from "@shared/messaging";

import { applyBadge } from "./badge";
import { routePortMessage } from "./router";
import { handleRuntimeMessage } from "./session/commands";
import { sessionAutoLock, sessionManager } from "./session/runtime";
import { logger } from "./telemetry/logger";

const SYNC_ALARM = "palladin.sync";

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

// Rehydrate any session that survived a worker restart in chrome.storage.session
// (an already-unlocked session comes back unlocked, no re-derive).
void sessionManager
  .initialize()
  .then((status) => {
    logger.debug("session initialized", { status });
    void applyBadge(chrome.action, status);
  })
  .catch(() => logger.warn("session init failed"));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_PORT) return;

  port.onMessage.addListener((raw) => {
    // The Port is isolated from the page, but the content script forwards
    // page-adjacent traffic — validate the shape before acting.
    if (!isBridgeMessage(raw)) return;
    if (raw.type === "session/activity") {
      // User activity: push the idle auto-lock deadline out (side effect).
      void sessionManager.touchActivity();
    }
    const reply = routePortMessage(raw);
    if (reply) port.postMessage(reply);
  });
});

// Popup ↔ worker command channel (login / unlock / lock / logout / settings).
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  void handleRuntimeMessage(sessionManager, raw).then((result) => {
    if (result !== null) sendResponse(result);
  });
  // Returning true keeps the message channel open for the async response.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // ~5 min cadence for the future delta-sync trigger (see the sync plan).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Idle auto-lock: the manager wipes keys when this fires.
  sessionAutoLock.dispatch(alarm.name);
  if (alarm.name !== SYNC_ALARM) return;
  // Sync engine lands later; today the tick is a value-free no-op.
  void sessionManager.getStatus();
});
