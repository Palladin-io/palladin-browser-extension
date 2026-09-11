import { isSharedUnlockBrowserMessage, type SharedUnlockBrowserMessage } from "../../shared/messaging/shared-unlock-browser";
import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";

export interface SharedUnlockBrowserApi {
  readonly extensionId: string;
  currentApiUrl(): string;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  getFrame(tabId: number): Promise<chrome.webNavigation.GetFrameResultDetails | null | undefined>;
}

/** The only authority here is browser-authored sender/tab/frame state + build configuration.
 * Does not authorize keys, account linking or Identity operations on its own. */
export class ChromiumSharedUnlockRoute {
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly documentBinding: string;
  private closed = false;
  private readonly port: chrome.runtime.Port;
  private readonly browser: SharedUnlockBrowserApi;
  readonly tabId: number;
  readonly documentId: string;
  private readonly onClosed: () => void;

  private constructor(port: chrome.runtime.Port, browser: SharedUnlockBrowserApi, environment: SharedUnlockEnvironment,
    tabId: number, documentId: string, channelId: string, onClosed: () => void) {
    this.port = port; this.browser = browser; this.apiUrl = environment.apiUrl; this.webOrigin = environment.webOrigin;
    this.extensionId = browser.extensionId; this.tabId = tabId; this.documentId = documentId;
    this.documentBinding = `${tabId}/${documentId}/${channelId}`;
    this.onClosed = onClosed;
  }

  static accept(port: chrome.runtime.Port, browser: SharedUnlockBrowserApi,
    environments: readonly SharedUnlockEnvironment[], channelId: string, onClosed: () => void): ChromiumSharedUnlockRoute | null {
    const sender = port.sender;
    // External extension/content-script/native senders cannot impersonate a Web document.
    if (!sender || sender.id !== undefined || sender.nativeApplication !== undefined || sender.frameId !== 0
      || sender.documentLifecycle !== "active" || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0
      || sender.tab?.incognito !== false || !sender.documentId || sender.documentId.length > 128
      || typeof sender.origin !== "string" || typeof sender.url !== "string") return null;
    const environment = environments.find(item => item.apiUrl === browser.currentApiUrl() && item.webOrigin === sender.origin);
    if (!environment || origin(sender.url) !== environment.webOrigin) return null;
    return new ChromiumSharedUnlockRoute(port, browser, environment, sender.tab!.id!, sender.documentId, channelId, onClosed);
  }

  /** Synchronous fence around crypto awaits; navigation callbacks retire this object. */
  assertCurrent(): void {
    if (this.closed || this.browser.currentApiUrl() !== this.apiUrl || this.browser.extensionId !== this.extensionId) {
      this.close();
      throw new Error("Shared unlock browser route changed");
    }
  }

  /** Query the CURRENT top frame by tab/frame ID, not the old document by its ID. */
  async verifyCurrent(): Promise<void> {
    this.assertCurrent();
    try {
      const [tab, frame] = await Promise.all([this.browser.getTab(this.tabId), this.browser.getFrame(this.tabId)]);
      this.assertCurrent();
      if (tab.id !== this.tabId || tab.incognito !== false || tab.discarded || (tab as chrome.tabs.Tab & { frozen?: boolean }).frozen
        || typeof tab.pendingUrl === "string" || !frame || frame.documentId !== this.documentId
        || frame.documentLifecycle !== "active" || frame.frameType !== "outermost_frame"
        || frame.parentFrameId !== -1 || frame.errorOccurred || origin(frame.url) !== this.webOrigin) {
        throw new Error("Shared unlock browser document changed");
      }
    } catch (error) { this.close(); throw error; }
  }

  /** Transport callers must finish verifyCurrent immediately before a sensitive send. */
  post(message: SharedUnlockBrowserMessage): void {
    this.assertCurrent();
    if (!isSharedUnlockBrowserMessage(message)) throw new Error("Invalid shared unlock browser message");
    this.port.postMessage(message);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.port.disconnect(); } catch { /* already disconnected */ }
    this.onClosed();
  }
}

function origin(url: string): string | null {
  try { const parsed = new URL(url); return parsed.username || parsed.password ? null : parsed.origin; }
  catch { return null; }
}
