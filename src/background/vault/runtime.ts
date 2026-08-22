/**
 * Composition root for the vault data layer: build the one live
 * canonical data service, the {@link ClipboardGuard}, and the injected effects
 * (active tab, fill transport) from the real Chrome APIs. Like the session
 * runtime, this is the only vault module that reaches for `chrome` / `fetch`;
 * everything else is pure and injected, so the whole surface stays unit-testable.
 * Imported solely by the worker bootstrap — never by tests.
 */

import {
  FILL_REQUEST_CHANNEL,
  TAB_URL_REQUEST_CHANNEL,
  isFillOutcome,
  isTabUrlResponse,
  type FillField,
  type FillOutcome,
} from "@shared/messaging";
import { clipboardCopyAvailable } from "@shared/config/build-target";

import { serverConfig } from "../config/server-runtime";
import type { AlarmScheduler } from "../session/auto-lock";
import { sessionManager } from "../session/runtime";
import { browserDocumentIdForTab } from "../tab-documents";
import { ClipboardGuard } from "./clipboard-guard";
import { clearClipboard } from "./clipboard-runtime";
import type { ActiveTab, VaultCommandDeps } from "./commands";
import { IndexedDbProtocol2Cache } from "./protocol2/cache";
import { Protocol2VaultClient } from "./protocol2/client";
import {
  Protocol2VaultDataService,
  type Protocol2SessionAccessor,
} from "./protocol2/service";

const alarms: AlarmScheduler = {
  create: (name, info) => chrome.alarms.create(name, info),
  clear: (name) => chrome.alarms.clear(name),
};

// The data layer reads session state through this narrow seam; the session
// module remains the owner of key custody and token rotation.
const session: Protocol2SessionAccessor = {
  getAccessToken: () => sessionManager.getAccessToken(),
  refreshAccessToken: () => sessionManager.refreshAccessToken(),
  getUserId: () => sessionManager.getUserId(),
  getPrivateKey: () => sessionManager.getKeys()?.privateKey ?? null,
};

export const vaultData = new Protocol2VaultDataService({
  client: new Protocol2VaultClient((...args) => fetch(...args), () => serverConfig.apiUrl),
  cache: new IndexedDbProtocol2Cache(),
  session,
});

export const clipboardGuard = new ClipboardGuard({ alarms, clear: clearClipboard });

/** The active tab, when `activeTab` grants URL access (popup invocation is a gesture). */
async function getActiveTab(): Promise<ActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;
  return resolveTabDocument(tab.id);
}

async function resolveTabDocument(tabId: number): Promise<ActiveTab | null> {
  const browserDocumentId = browserDocumentIdForTab(tabId);
  if (browserDocumentId === null) return null;
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { channel: TAB_URL_REQUEST_CHANNEL },
      { documentId: browserDocumentId },
    );
    return isTabUrlResponse(response)
      ? {
          id: tabId,
          url: response.url,
          documentId: response.documentId,
          browserDocumentId,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Open a new login tab, then bind to the exact top-frame document only after
 * navigation has completed. This pending operation contains no secret: the
 * caller supplies an HTTPS host derived from MemberIndex and decrypts only
 * after this function returns the final live document.
 */
async function openLoginTab(url: string): Promise<ActiveTab | null> {
  let created: chrome.tabs.Tab;
  try {
    created = await chrome.tabs.create({ url, active: true });
  } catch {
    return null;
  }
  if (created.id === undefined) return null;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(created.id);
    } catch {
      return null;
    }
    if (tab.status === "complete") {
      const target = await resolveTabDocument(created.id);
      if (target !== null) return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  return null;
}

/** Hand ready field values to a tab's isolated content script; absent = no form. */
async function sendFill(
  target: ActiveTab,
  expectedDomain: string | null,
  fields: readonly FillField[],
  submit: boolean,
  capabilityId: string | null,
): Promise<FillOutcome> {
  const expectedOrigin = httpsOrigin(target.url);
  if (expectedOrigin === null) return { ok: false, reason: "target-changed" };
  try {
    const outcome = await chrome.tabs.sendMessage(
      target.id,
      {
        channel: FILL_REQUEST_CHANNEL,
        documentId: target.documentId,
        expectedOrigin,
        expectedDomain,
        submit,
        capabilityId,
        fields,
      },
      { documentId: target.browserDocumentId },
    );
    return isFillOutcome(outcome) ? outcome : { ok: false, reason: "no-form" };
  } catch {
    // No content script on the page (or it is not reachable) — nothing to fill.
    return { ok: false, reason: "no-form" };
  }
}

function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export const vaultCommandDeps: VaultCommandDeps = {
  data: vaultData,
  entryWriter: vaultData,
  getActiveTab,
  openLoginTab,
  sendFill,
  clipboard: { available: clipboardCopyAvailable, arm: () => clipboardGuard.arm() },
};
