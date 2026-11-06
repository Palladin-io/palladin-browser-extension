import { activePageTab } from '../active-page-tab';
import { captureDocumentKey } from './document-identity';
import { captureDocumentRoutes, currentCaptureTop, resolveCaptureSource } from './document-route-runtime';
/** Chrome adapters for the pure capture coordinator. */

import {
  isCaptureDetectedMessage,
  isCaptureFillOutcome,
  isCapturePopupCommand,
  type CaptureDetectionAck,
  type CapturePopupResult,
} from "@shared/messaging/capture";

import { CaptureCoordinator, type CaptureSource, type CaptureTab } from "./coordinator";
import { vaultData } from "../vault/runtime";
import { generatorSuggestionsEnabled } from "../generator/runtime";
import { sessionManager } from "../session/runtime";
import { isGeneratePasswordCommand, isGeneratorPreviewCommand, type GeneratorPreviewResult, type CaptureGeneratedFillResult } from '@shared/messaging/capture';

async function getActiveTab(): Promise<CaptureTab | null> {
  const tab = await activePageTab();
  if (typeof tab?.id !== 'number' || tab.incognito) return null;
  const source = await currentCaptureTop(tab.id);
  return source ? { ...source, id: tab.id } : null;
}

export const captureCoordinator = new CaptureCoordinator({
  getActiveTab,
  async sendFill(tabId, browserDocumentId, message) {
    const keys = sessionManager.getKeys();
    if (keys === null) return { ok: false, reason: "stale-candidate" };
    const active = await getActiveTab();
    if (sessionManager.getKeys() !== keys) return { ok: false, reason: "stale-candidate" };
    if (active?.id !== tabId || captureDocumentKey(active) !== browserDocumentId
      || active.documentId !== message.expectedDocumentId
      || !sameHttpsOrigin(active.url, message.expectedOrigin)) return { ok: false, reason: "stale-candidate" };
    let raw: unknown;
    if (active.legacyRouteId) {
      const source = await captureDocumentRoutes?.resolve(tabId);
      if (!source || captureDocumentKey(source) !== browserDocumentId) return { ok: false, reason: 'stale-candidate' };
      raw = await captureDocumentRoutes?.request(source, message, () => sessionManager.getKeys() === keys);
    } else {
      if (!active.browserDocumentId) return { ok: false, reason: 'stale-candidate' };
      raw = await chrome.tabs.sendMessage(tabId, message, { documentId: active.browserDocumentId });
    }
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
export async function handleCaptureContentRuntimeMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): Promise<CaptureDetectionAck | null> {
  if (!isCaptureDetectedMessage(raw)) return null;
  const source = sender.documentId == null ? await resolveCaptureSource(sender, raw.documentId) : captureSourceFromSender(sender, extensionId);
  return { accepted: source !== null && sender.frameId === 0 && captureCoordinator.observe(raw, source) };
}

/** Called only after the worker bootstrap validates an extension-owned sender. */
export function handleCapturePopupRuntimeMessage(raw: unknown): Promise<CapturePopupResult> | null {
  if (!isCapturePopupCommand(raw)) return null;
  return captureCoordinator.dispatch(raw);
}

export async function handleGeneratePassword(raw: unknown, sender: chrome.runtime.MessageSender): Promise<CaptureGeneratedFillResult | null> {
  if (!isGeneratePasswordCommand(raw)) return null;
  const source = sender.documentId == null ? await resolveCaptureSource(sender, raw.documentId) : captureSourceFromSender(sender, chrome.runtime.id);
  const keys = sessionManager.getKeys();
  if (!source || sender.frameId !== 0 || keys === null || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) {
    return { status: 'blocked', reason: 'stale-prompt', saveAvailable: false };
  }
  if (!(await generatorSuggestionsEnabled()) || sessionManager.getKeys() !== keys) {
    return { status: 'blocked', reason: 'stale-prompt', saveAvailable: false };
  }
  return captureCoordinator.generate(raw, source);
}

export async function handleGeneratorPreview(raw: unknown, sender: chrome.runtime.MessageSender): Promise<GeneratorPreviewResult | null> {
  if (!isGeneratorPreviewCommand(raw)) return null;
  const source = sender.documentId == null ? await resolveCaptureSource(sender, raw.documentId) : captureSourceFromSender(sender, chrome.runtime.id);
  if (source && sender.frameId === 0 && raw.type === 'dismiss') return captureCoordinator.preview(raw, source);
  const keys = sessionManager.getKeys();
  if (!source || sender.frameId !== 0 || keys === null || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') {
    return { status: 'blocked', reason: 'stale-prompt', saveAvailable: false };
  }
  if (!(await generatorSuggestionsEnabled()) || sessionManager.getKeys() !== keys) return { status: 'blocked', reason: 'stale-prompt', saveAvailable: false };
  const result = await captureCoordinator.preview(raw, source);
  if (sessionManager.getKeys() !== keys) { captureCoordinator.clear(); return { status: 'blocked', reason: 'stale-prompt', saveAvailable: false }; }
  return result;
}

sessionManager.hooks.onLocked(() => captureCoordinator.clear());
