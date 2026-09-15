import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";
import { isFirefoxDocumentMarker } from "../../shared/messaging/shared-unlock-firefox-document";
import { SharedUnlockBrowserRoute } from "./browser-route";
import type { FirefoxSharedUnlockBrowserApi, FirefoxNavigationFrame } from "./firefox-route";

export interface FirefoxLegacyBrowserApi extends FirefoxSharedUnlockBrowserApi {
  getBrowserInfo(): Promise<{ name: string; version: string } | null>;
  readMarkers(tabId: number, frameId: number): Promise<{ top: unknown; bridge: unknown }>;
}

/** Older Gecko: native sender + current-browser reads of private document RAM.
 * A claimed Port marker is checked against a separately addressed current frame;
 * the top marker comes only from browser execution in the isolated top document. */
export class FirefoxLegacySharedUnlockRoute extends SharedUnlockBrowserRoute {
  readonly documentId = null;
  readonly bridgeDocumentId = null;
  private constructor(port: chrome.runtime.Port, private readonly browser: FirefoxLegacyBrowserApi,
    environment: SharedUnlockEnvironment, readonly tabId: number, readonly frameId: number,
    private readonly topMarker: string, private readonly bridgeMarker: string,
    private readonly stillConnected: () => boolean, channelId: string, onClosed: () => void) {
    // Private markers never enter Web framing or documentBinding.
    super(port, environment, browser.extensionId, channelId, `${tabId}/legacy/${channelId}`, onClosed);
  }

  static async accept(port: chrome.runtime.Port, browser: FirefoxLegacyBrowserApi,
    environments: readonly SharedUnlockEnvironment[], marker: string | null, channelId: string,
    stillConnected: () => boolean, onClosed: () => void): Promise<FirefoxLegacySharedUnlockRoute | null> {
    const sender = port.sender;
    const bridgeOrigin = browser.bridgeUrl.slice(0, browser.bridgeUrl.indexOf("/", "moz-extension://".length));
    if (!browser.bridgeUrl.startsWith("moz-extension://") || !sender || sender.id !== browser.extensionId
      || sender.url !== browser.bridgeUrl || sender.origin !== bridgeOrigin || sender.nativeApplication !== undefined
      || !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0 || sender.tab?.incognito !== false
      || !Number.isSafeInteger(sender.frameId) || sender.frameId! <= 0 || sender.documentId != null
      || !isFirefoxDocumentMarker(marker) || !stillConnected()) return null;
    const info = await bounded(() => browser.getBrowserInfo());
    const major = Number(info?.version.match(/^(\d+)(?:\.|$)/)?.[1]);
    if (!stillConnected() || info?.name !== "Firefox" || major < 140 || major >= 153 || !Number.isInteger(major)) return null;
    const frames = await bounded(() => browser.getFrames(sender.tab!.id!));
    if (!stillConnected()) return null;
    const top = frames.find(frame => frame.frameId === 0), bridge = frames.find(frame => frame.frameId === sender.frameId);
    if (!validFrames(top, bridge, browser.bridgeUrl)) return null;
    const environment = environments.find(item => item.apiUrl === browser.currentApiUrl() && item.webOrigin === origin(top!.url));
    if (!environment) return null;
    const markers = await bounded(() => browser.readMarkers(sender.tab!.id!, sender.frameId!));
    if (!stillConnected() || !isFirefoxDocumentMarker(markers.top) || markers.bridge !== marker) return null;
    const route = new FirefoxLegacySharedUnlockRoute(port, browser, environment, sender.tab!.id!, sender.frameId!,
      markers.top, marker, stillConnected, channelId, onClosed);
    await route.verifyCurrent();
    return route;
  }

  protected assertBrowserCurrent(): void {
    if (!this.stillConnected() || this.browser.extensionId !== this.extensionId || this.browser.currentApiUrl() !== this.apiUrl) {
      throw new Error("Shared unlock legacy Firefox route changed");
    }
  }

  async verifyCurrent(): Promise<void> {
    this.assertCurrent();
    try {
      const [tab, frames, markers] = await bounded(() => Promise.all([
        this.browser.getTab(this.tabId), this.browser.getFrames(this.tabId), this.browser.readMarkers(this.tabId, this.frameId),
      ]));
      this.assertCurrent();
      const top = frames.find(frame => frame.frameId === 0), bridge = frames.find(frame => frame.frameId === this.frameId);
      if (tab.id !== this.tabId || tab.incognito !== false || tab.status !== "complete" || tab.discarded
        || (tab as chrome.tabs.Tab & { frozen?: boolean }).frozen || tab.pendingUrl !== undefined
        || !validFrames(top, bridge, this.browser.bridgeUrl) || origin(top!.url) !== this.webOrigin
        || markers.top !== this.topMarker || markers.bridge !== this.bridgeMarker) throw new Error("Shared unlock legacy Firefox document changed");
    } catch (error) { this.close(); throw error; }
  }
}

function validFrames(top: FirefoxNavigationFrame | undefined, bridge: FirefoxNavigationFrame | undefined, bridgeUrl: string): boolean {
  return !!top && !!bridge && top.parentFrameId === -1 && bridge.parentFrameId === 0 && bridge.url === bridgeUrl
    && !top.errorOccurred && !bridge.errorOccurred && top.documentId == null && bridge.documentId == null && bridge.parentDocumentId == null;
}
function origin(value: string): string | null {
  try { const url = new URL(value); return url.username || url.password ? null : url.origin; } catch { return null; }
}
async function bounded<T>(read: () => Promise<T>): Promise<T> {
  const started = Date.now(), monotonic = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Firefox document read timed out")), 2000);
    })]);
    if (Date.now() < started || Date.now() - started >= 2000 || performance.now() - monotonic >= 2000) throw new Error("Firefox document read expired");
    return value;
  } finally { clearTimeout(timer); }
}
