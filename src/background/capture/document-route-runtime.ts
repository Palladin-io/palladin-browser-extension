import { extensionBuildTarget } from '@shared/config/build-target';
import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse } from '@shared/messaging';
import { browserDocumentIdForTab } from '../tab-documents';
import { CaptureDocumentRoutes } from './document-route';
import { SecretCaptureFrames } from './secret-source';
import type { SecretCaptureSource } from './secret-coordinator';
export const secretCaptureFrames = new SecretCaptureFrames(browserDocumentIdForTab);
const retired = new Set<(tabId: number, routeId: string, frameId: number) => void>();
const connected = new Set<(source: SecretCaptureSource) => void>();
export const captureDocumentRoutes = extensionBuildTarget === 'firefox' ? new CaptureDocumentRoutes({
    extensionId: chrome.runtime.id,
    getBrowserInfo: async () => { const runtime = chrome.runtime as typeof chrome.runtime & {
        getBrowserInfo?: () => Promise<{
            name: string;
            version: string;
        }>;
    }; return runtime.getBrowserInfo?.() ?? null; },
    getTab: id => chrome.tabs.get(id),
    probe: (tabId, frameId) => chrome.tabs.sendMessage(tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { frameId }),
    retired: (tabId, routeId, frameId) => { for (const callback of retired)
        callback(tabId, routeId, frameId); },
    connected: source => { for (const callback of connected)
        callback(source); },
}) : null;
export function onCaptureRouteRetired(callback: (tabId: number, routeId: string, frameId: number) => void): void { retired.add(callback); }
export function onCaptureRouteConnected(callback: (source: SecretCaptureSource) => void): void { connected.add(callback); }
export async function resolveCaptureSource(sender: chrome.runtime.MessageSender, documentId: string): Promise<SecretCaptureSource | null> {
    if (sender.documentId != null)
        return secretCaptureFrames.source(sender, chrome.runtime.id, documentId);
    return captureDocumentRoutes?.resolveSource(documentId, sender) ?? null;
}
export async function currentCaptureTop(tabId: number): Promise<SecretCaptureSource | null> {
    const browserDocumentId = browserDocumentIdForTab(tabId);
    if (!browserDocumentId)
        return captureDocumentRoutes?.resolve(tabId) ?? null;
    try {
        const response = await chrome.tabs.sendMessage(tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { documentId: browserDocumentId });
        if (browserDocumentIdForTab(tabId) !== browserDocumentId || !isTabUrlResponse(response) || new URL(response.url).protocol !== 'https:')
            return null;
        return { tabId, frameId: 0, browserDocumentId, topDocumentId: browserDocumentId, documentId: response.documentId, url: response.url };
    }
    catch {
        return null;
    }
}
export async function currentCaptureDocument(source: SecretCaptureSource): Promise<boolean> {
    if (source.legacyRouteId)
        return !source.browserDocumentId && !source.topDocumentId && await (captureDocumentRoutes?.current(source) ?? false);
    if (!source.browserDocumentId || !source.topDocumentId || browserDocumentIdForTab(source.tabId) !== source.topDocumentId)
        return false;
    const sender = { id: chrome.runtime.id, tab: { id: source.tabId }, frameId: source.frameId, documentId: source.browserDocumentId, url: source.url } as chrome.runtime.MessageSender;
    if (!secretCaptureFrames.source(sender, chrome.runtime.id, source.documentId))
        return false;
    try {
        const response = await chrome.tabs.sendMessage(source.tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { documentId: source.browserDocumentId });
        return secretCaptureFrames.source(sender, chrome.runtime.id, source.documentId) !== null && browserDocumentIdForTab(source.tabId) === source.topDocumentId
            && isTabUrlResponse(response) && response.documentId === source.documentId && response.url === source.url;
    }
    catch {
        return false;
    }
}
export async function currentLegacyCaptureLogin(source: {
    tabId: number;
    documentId: string;
    legacyRouteId?: string;
    url: string;
}): Promise<boolean> {
    const current = await captureDocumentRoutes?.resolve(source.tabId);
    return !!current && current.legacyRouteId === source.legacyRouteId && current.documentId === source.documentId && new URL(current.url).origin === new URL(source.url).origin;
}
