/** Chrome adapters for the pure capture coordinator. */

import {
  isCaptureDetectedMessage,
  isCaptureFillOutcome,
  isCapturePopupCommand,
  type CaptureDetectionAck,
  type CapturePopupResult,
} from "@shared/messaging/capture";
import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse } from "@shared/messaging";

import { CaptureCoordinator, type CaptureSource, type CaptureTab } from "./coordinator";
import { browserDocumentIdForTab } from "../tab-documents";
import { vaultData } from "../vault/runtime";

async function getActiveTab(): Promise<CaptureTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== "number") return null;
  const browserDocumentId = browserDocumentIdForTab(tab.id);
  if (browserDocumentId === null) return null;
  try {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      { channel: TAB_URL_REQUEST_CHANNEL },
      { documentId: browserDocumentId },
    );
    return isTabUrlResponse(response)
      ? {
          id: tab.id,
          url: response.url,
          documentId: response.documentId,
          browserDocumentId,
        }
      : null;
  } catch {
    return null;
  }
}

export const captureCoordinator = new CaptureCoordinator({
  getActiveTab,
  async sendFill(tabId, browserDocumentId, message) {
    const raw = await chrome.tabs.sendMessage(tabId, message, { documentId: browserDocumentId });
    return isCaptureFillOutcome(raw) ? raw : { ok: false, reason: "no-form" };
  },
  savePassword: (input) => vaultData.saveGeneratedPassword(input),
});

function sameHttpsOrigin(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    return (
      first.protocol === "https:" &&
      second.protocol === "https:" &&
      first.origin === second.origin
    );
  } catch {
    return false;
  }
}

export function captureSourceFromSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): CaptureSource | null {
  if (sender.id !== extensionId || sender.frameId !== 0) return null;
  if (typeof sender.tab?.id !== "number" || typeof sender.tab.url !== "string") return null;
  if (typeof sender.documentId !== "string" || sender.documentId.length === 0) return null;
  if (typeof sender.url !== "string" || !sameHttpsOrigin(sender.url, sender.tab.url)) return null;
  return { tabId: sender.tab.id, url: sender.url, browserDocumentId: sender.documentId };
}

/** Handles only shape-only observations from a top-frame content script. */
export function handleCaptureContentRuntimeMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): CaptureDetectionAck | null {
  if (!isCaptureDetectedMessage(raw)) return null;
  const source = captureSourceFromSender(sender, extensionId);
  return { accepted: source !== null && captureCoordinator.observe(raw, source) };
}

/** Called only after the worker bootstrap validates an extension-owned sender. */
export function handleCapturePopupRuntimeMessage(raw: unknown): Promise<CapturePopupResult> | null {
  if (!isCapturePopupCommand(raw)) return null;
  return captureCoordinator.dispatch(raw);
}
