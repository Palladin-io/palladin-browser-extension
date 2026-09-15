import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { SharedUnlockBrowserRoute } from "./browser-route";

export interface FirefoxNavigationFrame {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly documentId?: string | undefined;
  readonly parentDocumentId?: string | null | undefined;
  readonly url: string;
  readonly errorOccurred?: boolean;
}
export interface FirefoxSharedUnlockBrowserApi {
  readonly extensionId: string;
  readonly bridgeUrl: string;
  currentApiUrl(): string;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  getFrames(tabId: number): Promise<readonly FirefoxNavigationFrame[]>;
}

/** Firefox uses an own extension iframe directly inside the configured Web top
 * document. Its browser-authored parentDocumentId is the Web document authority;
 * no page-supplied document, ID, origin or tab number selects this route. */
export class FirefoxSharedUnlockRoute extends SharedUnlockBrowserRoute {
  private constructor(port: chrome.runtime.Port, private readonly browser: FirefoxSharedUnlockBrowserApi,
    environment: SharedUnlockEnvironment, readonly tabId: number, readonly frameId: number,
    readonly documentId: string, readonly bridgeDocumentId: string, channelId: string, onClosed: () => void) {
    super(port, environment, browser.extensionId, channelId, `${tabId}/${documentId}/${bridgeDocumentId}/${channelId}`, onClosed);
  }

  static async accept(port: chrome.runtime.Port, browser: FirefoxSharedUnlockBrowserApi,
    environments: readonly SharedUnlockEnvironment[], channelId: string, onClosed: () => void): Promise<FirefoxSharedUnlockRoute | null> {
    const sender = port.sender;
    const bridgeOrigin = browser.bridgeUrl.slice(0, browser.bridgeUrl.indexOf("/", "moz-extension://".length));
    if (!browser.bridgeUrl.startsWith("moz-extension://") || !sender || sender.id !== browser.extensionId
      || sender.url !== browser.bridgeUrl || sender.origin !== bridgeOrigin || sender.nativeApplication !== undefined
      || !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0 || sender.tab?.incognito !== false
      || !Number.isSafeInteger(sender.frameId) || sender.frameId! <= 0 || !documentId(sender.documentId)) return null;
    const frames = await browser.getFrames(sender.tab!.id!);
    const top = frames.find(frame => frame.frameId === 0);
    const bridge = frames.find(frame => frame.frameId === sender.frameId);
    if (!top || !bridge || top.parentFrameId !== -1 || !documentId(top.documentId)
      || bridge.documentId !== sender.documentId || bridge.parentFrameId !== 0
      || bridge.parentDocumentId !== top.documentId || bridge.url !== browser.bridgeUrl
      || bridge.errorOccurred || top.errorOccurred) return null;
    const environment = environments.find(item => item.apiUrl === browser.currentApiUrl() && item.webOrigin === origin(top.url));
    if (!environment) return null;
    return new FirefoxSharedUnlockRoute(port, browser, environment, sender.tab!.id!, sender.frameId!,
      top.documentId, sender.documentId, channelId, onClosed);
  }

  protected assertBrowserCurrent(): void {
    if (this.browser.extensionId !== this.extensionId || this.browser.currentApiUrl() !== this.apiUrl) {
      throw new Error("Shared unlock Firefox route changed");
    }
  }

  async verifyCurrent(): Promise<void> {
    this.assertCurrent();
    try {
      const [tab, frames] = await Promise.all([this.browser.getTab(this.tabId), this.browser.getFrames(this.tabId)]);
      this.assertCurrent();
      const top = frames.find(frame => frame.frameId === 0), bridge = frames.find(frame => frame.frameId === this.frameId);
      if (tab.id !== this.tabId || tab.incognito !== false || tab.discarded || (tab as chrome.tabs.Tab & { frozen?: boolean }).frozen || tab.pendingUrl !== undefined
        || !top || top.parentFrameId !== -1 || top.documentId !== this.documentId || origin(top.url) !== this.webOrigin
        || top.errorOccurred || !bridge || bridge.documentId !== this.bridgeDocumentId || bridge.parentFrameId !== 0
        || bridge.parentDocumentId !== this.documentId || bridge.url !== this.browser.bridgeUrl || bridge.errorOccurred) {
        throw new Error("Shared unlock Firefox document changed");
      }
    } catch (error) { this.close(); throw error; }
  }
}

function documentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}
function origin(value: string): string | null {
  try { const url = new URL(value); return url.username || url.password ? null : url.origin; } catch { return null; }
}
