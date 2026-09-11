import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { isSafariSharedUnlockExtensionId } from "../../shared/messaging/shared-unlock-browser";
import { SharedUnlockBrowserRoute } from "./browser-route";

export interface SafariSharedUnlockBrowserApi {
  readonly extensionId: string;
  extensionUrl(): string;
  currentApiUrl(): string;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  getFrame(tabId: number): Promise<chrome.webNavigation.GetFrameResultDetails | null | undefined>;
}

/** Safari authority is the native external sender plus an independent lookup of
 * the CURRENT top document. No documentLifecycle/frameType is fabricated when
 * Safari omits it. Navigation retirement and a settled, normal tab are required. */
export class SafariSharedUnlockRoute extends SharedUnlockBrowserRoute {
  private constructor(port: chrome.runtime.Port, private readonly browser: SafariSharedUnlockBrowserApi,
    environment: SharedUnlockEnvironment, readonly tabId: number, readonly documentId: string,
    private readonly extensionUrl: string, channelId: string, onClosed: () => void) {
    super(port, environment, browser.extensionId, channelId, `${tabId}/${documentId}/${channelId}`, onClosed);
  }

  static accept(port: chrome.runtime.Port, browser: SafariSharedUnlockBrowserApi,
    environments: readonly SharedUnlockEnvironment[], channelId: string, onClosed: () => void): SafariSharedUnlockRoute | null {
    const sender = port.sender, extensionUrl = browser.extensionUrl();
    if (!isSafariSharedUnlockExtensionId(browser.extensionId) || !validExtensionUrl(extensionUrl)
      || !sender || sender.id !== undefined || sender.nativeApplication !== undefined || sender.frameId !== 0
      || !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0 || sender.tab?.incognito !== false
      || !documentId(sender.documentId) || typeof sender.origin !== "string" || typeof sender.url !== "string"
      || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")) return null;
    const environment = environments.find(item => item.apiUrl === browser.currentApiUrl() && item.webOrigin === sender.origin);
    if (!environment || origin(sender.url) !== environment.webOrigin || origin(sender.tab?.url) !== environment.webOrigin) return null;
    return new SafariSharedUnlockRoute(port, browser, environment, sender.tab!.id!, sender.documentId, extensionUrl, channelId, onClosed);
  }

  protected assertBrowserCurrent(): void {
    if (this.browser.extensionId !== this.extensionId || this.browser.extensionUrl() !== this.extensionUrl
      || this.browser.currentApiUrl() !== this.apiUrl) throw new Error("Shared unlock Safari route changed");
  }

  async verifyCurrent(): Promise<void> {
    this.assertCurrent();
    const started = Date.now(), monotonic = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [tab, frame] = await Promise.race([
        Promise.all([this.browser.getTab(this.tabId), this.browser.getFrame(this.tabId)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Safari document read timed out")), 2000); }),
      ]);
      this.assertCurrent();
      if (Date.now() < started || Date.now() - started >= 2000 || performance.now() - monotonic >= 2000
        || tab.id !== this.tabId || tab.incognito !== false || tab.status !== "complete" || tab.discarded
        || (tab as chrome.tabs.Tab & { frozen?: boolean }).frozen || tab.pendingUrl !== undefined
        || origin(tab.url) !== this.webOrigin || !frame || frame.parentFrameId !== -1
        || frame.documentId !== this.documentId || origin(frame.url) !== this.webOrigin || frame.errorOccurred
        || (frame.documentLifecycle !== undefined && frame.documentLifecycle !== "active")
        || (frame.frameType !== undefined && frame.frameType !== "outermost_frame")) {
        throw new Error("Shared unlock Safari document changed");
      }
    } catch (error) { this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
}

function documentId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}
function origin(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.username || url.password ? null : url.origin; } catch { return null; }
}
function validExtensionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "safari-web-extension:" && documentId(url.hostname)
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
