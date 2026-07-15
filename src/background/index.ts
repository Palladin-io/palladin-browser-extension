/**
 * Service worker entry point (MV3). Bootstrap only: it wires the content Port,
 * routes messages through the pure {@link routePortMessage}, and registers the
 * background sync alarm. No crypto, no keys, no network yet — those arrive with
 * later phases. Everything security-sensitive is gated downstream, never here on
 * the strength of a page-originated message.
 */

import {
  CONTENT_PORT,
  isBridgeMessage,
} from "@shared/messaging";

import { routePortMessage } from "./router";
import { getSessionStatus } from "./session";

const SYNC_ALARM = "palladin.sync";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_PORT) return;

  port.onMessage.addListener((raw) => {
    // The Port itself is isolated from the page, but the content script forwards
    // page-adjacent traffic — so we still validate the shape before acting.
    if (!isBridgeMessage(raw)) return;
    const reply = routePortMessage(raw);
    if (reply) port.postMessage(reply);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  // ~5 min cadence for the future delta-sync trigger (see the sync plan).
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  // Sync engine lands later; today the tick is a no-op that only reads the
  // in-memory lock status (value-free).
  void getSessionStatus();
});
