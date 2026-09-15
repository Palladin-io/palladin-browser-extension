import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { SharedUnlockBrowserRoute } from "./browser-route";

export interface SharedUnlockBrowserApi {
  readonly extensionId: string;
  currentApiUrl(): string;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  getFrame(tabId: number): Promise<chrome.webNavigation.GetFrameResultDetails | null | undefined>;
}

/** Chromium authority comes only from the browser's external sender/current frame. */
export class ChromiumSharedUnlockRoute extends SharedUnlockBrowserRoute {
  private constructor(port: chrome.runtime.Port, private readonly browser: SharedUnlockBrowserApi,
    environment: SharedUnlockEnvironment, readonly tabId: number, readonly documentId: string,
    channelId: string, onClosed: () => void) {
    super(port, environment, browser.extensionId, channelId, `${tabId}/${documentId}/${channelId}`, onClosed);
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

  protected assertBrowserCurrent(): void {
    if (this.browser.currentApiUrl() !== this.apiUrl || this.browser.extensionId !== this.extensionId) {
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

}

function origin(url: string): string | null {
  try { const parsed = new URL(url); return parsed.username || parsed.password ? null : parsed.origin; }
  catch { return null; }
}
