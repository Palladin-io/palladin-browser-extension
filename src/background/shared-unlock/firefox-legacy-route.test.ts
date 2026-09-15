import { afterEach, describe, expect, it, vi } from "vitest";
import { FirefoxLegacySharedUnlockRoute, type FirefoxLegacyBrowserApi } from "./firefox-legacy-route";

const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
const topMarker = "aaaabbbb-1234-4567-8abc-111111111111", bridgeMarker = "ccccdddd-1234-4567-8abc-222222222222";
function fixture() {
  const bridgeOrigin = "moz-extension://ab38a993-33a3-4380-9b40-0deef02e3b41";
  const bridgeUrl = bridgeOrigin + "/src/shared-unlock-bridge/index.html";
  const tab = { id: 7, incognito: false, discarded: false, status: "complete" } as chrome.tabs.Tab;
  const top = { frameId: 0, parentFrameId: -1, url: environments[0].webOrigin + "/vaults" };
  const bridge = { frameId: 15032385537, parentFrameId: 0, url: bridgeUrl };
  const sender: chrome.runtime.MessageSender = { id: "browser-extension@palladin.io", tab,
    frameId: bridge.frameId, origin: bridgeOrigin, url: bridgeUrl };
  const port = { sender, disconnect: vi.fn(), postMessage: vi.fn() } as unknown as chrome.runtime.Port;
  const markers = { top: topMarker, bridge: bridgeMarker };
  const browser: FirefoxLegacyBrowserApi = { extensionId: sender.id!, bridgeUrl,
    currentApiUrl: vi.fn(() => environments[0].apiUrl), getTab: vi.fn(async () => tab),
    getFrames: vi.fn(async () => [top, bridge]), readMarkers: vi.fn(async () => markers),
    getBrowserInfo: vi.fn(async () => ({ name: "Firefox", version: "140.0" })) };
  const state = { connected: true }, onClosed = vi.fn();
  return { tab, top, bridge, sender, port, browser, markers, state, onClosed,
    accept: (marker: string | null = bridgeMarker) => FirefoxLegacySharedUnlockRoute.accept(port, browser, environments,
      marker, "A".repeat(43), () => state.connected, onClosed) };
}
afterEach(() => vi.useRealTimers());
describe("Firefox 140-152 independent current-document reads", () => {
  it("pins private markers without exposing either in the Web binding", async () => {
    const f = fixture(), route = (await f.accept())!;
    expect(route.documentBinding).toBe(`7/legacy/${"A".repeat(43)}`);
    expect(route.documentBinding).not.toContain(topMarker); expect(route.documentBinding).not.toContain(bridgeMarker);
    await route.verifyCurrent(); f.top.url = environments[0].webOrigin + "/other#fragment";
    await route.verifyCurrent(); expect(route.signal.aborted).toBe(false);
  });
  it.each([null, { name: "Chromium", version: "140.0" }, { name: "Firefox", version: "139.0" },
    { name: "Firefox", version: "153.0" }, { name: "Firefox", version: "155.0" }, { name: "Firefox", version: "invalid" }])(
    "never substitutes markers for missing modern native authority %#", async info => {
      const f = fixture(); vi.mocked(f.browser.getBrowserInfo).mockResolvedValue(info);
      expect(await f.accept()).toBeNull(); expect(f.browser.readMarkers).not.toHaveBeenCalled();
    });
  it.each([null, "page-marker", topMarker])("rejects an absent or forged Port marker %#", async marker => {
    const f = fixture(); expect(await f.accept(marker)).toBeNull();
  });
  it.each(["top-id", "bridge-id", "parent-id", "top-parent", "bridge-parent", "bridge-url", "top-error", "bridge-error", "web-port", "web-credentials"])(
    "does not accept mismatched current-browser %s", async reason => {
      const f = fixture();
      if (reason === "top-id") Object.assign(f.top, { documentId: "native" });
      if (reason === "bridge-id") Object.assign(f.bridge, { documentId: "native" });
      if (reason === "parent-id") Object.assign(f.bridge, { parentDocumentId: "native" });
      if (reason === "top-parent") f.top.parentFrameId = 1;
      if (reason === "bridge-parent") f.bridge.parentFrameId = 1;
      if (reason === "bridge-url") f.bridge.url += "?other";
      if (reason === "top-error") Object.assign(f.top, { errorOccurred: true });
      if (reason === "bridge-error") Object.assign(f.bridge, { errorOccurred: true });
      if (reason === "web-port") f.top.url = "https://app.example.test";
      if (reason === "web-credentials") f.top.url = "https://name@app.example.test:8443";
      expect(await f.accept()).toBeNull();
    });
  it.each([{ id: "other@test.invalid" }, { origin: environments[0].webOrigin }, { frameId: 0 },
    { url: "https://evil.example.test" }, { documentId: "modern-document" }, { tab: { id: 7, incognito: true } }])(
    "rejects a different browser sender before marker reads %#", async patch => {
      const f = fixture(); Object.assign(f.sender, patch); expect(await f.accept()).toBeNull();
      expect(f.browser.readMarkers).not.toHaveBeenCalled();
    });
  it.each(["top", "bridge", "nested", "origin", "loading", "incognito", "pending", "discarded", "frozen", "removed", "api", "port"])(
    "retires after a %s change even when the URL and frameId can stay the same", async reason => {
      const f = fixture(), route = (await f.accept())!;
      if (reason === "top") f.markers.top = bridgeMarker;
      if (reason === "bridge") f.markers.bridge = topMarker;
      if (reason === "nested") f.bridge.parentFrameId = 9;
      if (reason === "origin") f.top.url = "https://evil.example.test";
      if (reason === "loading") f.tab.status = "loading";
      if (reason === "incognito") f.tab.incognito = true;
      if (reason === "pending") f.tab.pendingUrl = f.top.url;
      if (reason === "discarded") f.tab.discarded = true;
      if (reason === "frozen") Object.assign(f.tab, { frozen: true });
      if (reason === "removed") vi.mocked(f.browser.getFrames).mockResolvedValue([f.top]);
      if (reason === "api") vi.mocked(f.browser.currentApiUrl).mockReturnValue("https://other.example.test");
      if (reason === "port") f.state.connected = false;
      await expect(route.verifyCurrent()).rejects.toThrow(); expect(route.signal.aborted).toBe(true);
    });
  it("cannot install after navigation closes a Port during acceptance", async () => {
    const f = fixture(); let finish!: (value: typeof f.markers) => void;
    vi.mocked(f.browser.readMarkers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const accepted = f.accept(); for (let i = 0; i < 25; i++) await Promise.resolve();
    f.state.connected = false; finish(f.markers);
    expect(await accepted).toBeNull();
  });
  it("discards an old matching reply after route closure", async () => {
    const f = fixture(), route = (await f.accept())!;
    let finish!: (value: typeof f.markers) => void;
    vi.mocked(f.browser.readMarkers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const verification = route.verifyCurrent(); route.close(); finish(f.markers);
    await expect(verification).rejects.toThrow(); expect(f.onClosed).toHaveBeenCalledOnce();
  });
  it("fails closed if the browser's current document never responds", async () => {
    vi.useFakeTimers(); const f = fixture(), route = (await f.accept())!;
    vi.mocked(f.browser.readMarkers).mockImplementation(() => new Promise(() => undefined));
    const verification = expect(route.verifyCurrent()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2000); await verification; expect(route.signal.aborted).toBe(true);
  });
  it("rejects a response that expired during suspension before timers ran", async () => {
    const f = fixture(), route = (await f.accept())!;
    vi.mocked(f.browser.readMarkers).mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000); return f.markers;
    });
    try { await expect(route.verifyCurrent()).rejects.toThrow("expired"); } finally { vi.restoreAllMocks(); }
  });
});
