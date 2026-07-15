/**
 * Composition root for the vault data layer: build the one live
 * {@link VaultDataService}, the {@link ClipboardGuard}, and the injected effects
 * (active tab, fill transport) from the real Chrome APIs. Like the session
 * runtime, this is the only vault module that reaches for `chrome` / `fetch`;
 * everything else is pure and injected, so the whole surface stays unit-testable.
 * Imported solely by the worker bootstrap — never by tests.
 */

import {
  FILL_REQUEST_CHANNEL,
  isFillOutcome,
  type FillField,
  type FillOutcome,
} from "@shared/messaging";

import { env } from "../config/env";
import type { AlarmScheduler } from "../session/auto-lock";
import { sessionManager } from "../session/runtime";
import type { StorageArea } from "../session/session-store";
import { ClipboardGuard } from "./clipboard-guard";
import { clearClipboard } from "./clipboard-runtime";
import type { ActiveTab, VaultCommandDeps } from "./commands";
import { VaultClient } from "./vault-client";
import { VaultDataService, type SessionAccessor } from "./vault-data-service";
import { VaultStore } from "./vault-store";

// Same sanctioned area the session uses: chrome.storage.session (memory-backed).
const storageArea: StorageArea = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
};

const alarms: AlarmScheduler = {
  create: (name, info) => chrome.alarms.create(name, info),
  clear: (name) => chrome.alarms.clear(name),
};

// The data layer reads session state through this narrow seam; the session
// module remains the owner of key custody and token rotation.
const session: SessionAccessor = {
  getAccessToken: () => sessionManager.getAccessToken(),
  refreshAccessToken: () => sessionManager.refreshAccessToken(),
  getPrivateKey: () => sessionManager.getKeys()?.privateKey ?? null,
};

export const vaultData = new VaultDataService({
  client: new VaultClient((...args) => fetch(...args), env.apiUrl),
  store: new VaultStore(storageArea),
  session,
});

export const clipboardGuard = new ClipboardGuard({ alarms, clear: clearClipboard });

/** The active tab, when `activeTab` grants URL access (popup invocation is a gesture). */
async function getActiveTab(): Promise<ActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) return null;
  return { id: tab.id, url: tab.url };
}

/** Hand ready field values to a tab's isolated content script; absent = no form. */
async function sendFill(
  tabId: number,
  fields: readonly FillField[],
): Promise<FillOutcome> {
  try {
    const outcome = await chrome.tabs.sendMessage(tabId, {
      channel: FILL_REQUEST_CHANNEL,
      fields,
    });
    return isFillOutcome(outcome) ? outcome : { ok: false, reason: "no-form" };
  } catch {
    // No content script on the page (or it is not reachable) — nothing to fill.
    return { ok: false, reason: "no-form" };
  }
}

export const vaultCommandDeps: VaultCommandDeps = {
  data: vaultData,
  getActiveTab,
  sendFill,
  clipboard: { arm: () => clipboardGuard.arm() },
};
