import { describe, expect, it, vi } from "vitest";
import { FirefoxSharedUnlockRoute, type FirefoxSharedUnlockBrowserApi } from "./firefox-route";

const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
function fixture() {
  const bridgeOrigin = "moz-extension://ab38a993-33a3-4380-9b40-0deef02e3b41";
  const bridgeUrl = bridgeOrigin + "/src/shared-unlock-bridge/index.html";
  const tab = { id: 7, incognito: false, discarded: false } as chrome.tabs.Tab;
  const top = { frameId: 0, parentFrameId: -1, documentId: "top-1", parentDocumentId: null,
    url: environments[0].webOrigin + "/vaults", errorOccurred: false };
  const bridge = { frameId: 15032385537, parentFrameId: 0, documentId: "bridge-1", parentDocumentId: top.documentId,
    url: bridgeUrl, errorOccurred: false };
  const sender: chrome.runtime.MessageSender = { id: "browser-extension@palladin.io", tab,
    frameId: bridge.frameId, documentId: bridge.documentId, origin: bridgeOrigin, url: bridgeUrl };
  const port = { sender, disconnect: vi.fn(), postMessage: vi.fn() } as unknown as chrome.runtime.Port;
  const browser: FirefoxSharedUnlockBrowserApi = { extensionId: sender.id!, bridgeUrl,
    currentApiUrl: vi.fn(() => environments[0].apiUrl), getTab: vi.fn(async () => tab), getFrames: vi.fn(async () => [top, bridge]) };
  const onClosed = vi.fn();
  return { tab, top, bridge, sender, port, browser, onClosed,
    accept: () => FirefoxSharedUnlockRoute.accept(port, browser, environments, "A".repeat(43), onClosed) };
}

describe("Firefox browser-authored document route", () => {
  it("binds own ID, exact bridge and its browser-confirmed direct parent; accepts 64-bit frame IDs", async () => {
    const f = fixture(), route = (await f.accept())!;
    expect(route.documentBinding).toBe(`7/top-1/bridge-1/${"A".repeat(43)}`);
    await route.verifyCurrent(); f.top.url = environments[0].webOrigin + "/other#hash";
    await route.verifyCurrent(); expect(f.onClosed).not.toHaveBeenCalled();
  });
  it.each([
    ["other extension", { id: "other@palladin-test.invalid" }], ["missing ID", { id: undefined }],
    ["native application", { nativeApplication: "host" }], ["top frame", { frameId: 0 }],
    ["fractional frame", { frameId: 0.5 }], ["missing document", { documentId: undefined }],
    ["oversized document", { documentId: "a".repeat(81) }], ["missing tab", { tab: undefined }],
    ["incognito", { tab: { id: 7, incognito: true } }], ["missing incognito flag", { tab: { id: 7 } }],
    ["negative tab", { tab: { id: -1, incognito: false } }], ["fractional tab", { tab: { id: 0.5, incognito: false } }],
    ["other origin", { origin: "moz-extension://other" }], ["opaque origin", { origin: "null" }],
    ["Web content script", { origin: environments[0].webOrigin, url: environments[0].webOrigin }],
    ["different own resource", { url: "moz-extension://ab38a993-33a3-4380-9b40-0deef02e3b41/popup.html" }],
  ])("rejects %s before a browser lookup", async (_name, patch) => {
    const f = fixture(); Object.assign(f.sender, patch);
    expect(await f.accept()).toBeNull(); expect(f.browser.getFrames).not.toHaveBeenCalled();
  });
  it.each([
    ["missing parent authority", { parentDocumentId: undefined }], ["substituted parent", { parentDocumentId: "other" }],
    ["nested parent", { parentFrameId: 2 }], ["stale bridge", { documentId: "other" }],
    ["wrong bridge URL", { url: "https://evil.example.test" }], ["failed bridge", { errorOccurred: true }],
  ])("rejects %s independently of sender claims", async (_name, patch) => {
    const f = fixture(); Object.assign(f.bridge, patch); expect(await f.accept()).toBeNull();
  });
  it.each([
    ["missing top authority", { documentId: undefined }], ["nested top", { parentFrameId: 1 }],
    ["different Web origin", { url: "https://other.example.test" }], ["wrong Web port", { url: "https://app.example.test" }],
    ["URL credentials", { url: "https://name@app.example.test:8443" }], ["top error", { errorOccurred: true }],
  ])("rejects %s", async (_name, patch) => {
    const f = fixture(); Object.assign(f.top, patch); expect(await f.accept()).toBeNull();
  });
  it("requires the independently configured current API", async () => {
    const f = fixture(); vi.mocked(f.browser.currentApiUrl).mockReturnValue("https://other.example.test");
    expect(await f.accept()).toBeNull();
  });
  it.each(["top", "bridge", "parent", "removed", "incognito", "pending", "frozen", "discarded", "api"])("retires after %s changes", async reason => {
    const f = fixture(), route = (await f.accept())!;
    if (reason === "top") f.top.documentId = "new-top";
    if (reason === "bridge") f.bridge.documentId = "new-bridge";
    if (reason === "parent") f.bridge.parentDocumentId = "new-parent";
    if (reason === "removed") vi.mocked(f.browser.getFrames).mockResolvedValue([f.top]);
    if (reason === "incognito") f.tab.incognito = true;
    if (reason === "pending") f.tab.pendingUrl = f.top.url;
    if (reason === "frozen") Object.assign(f.tab, { frozen: true });
    if (reason === "discarded") f.tab.discarded = true;
    if (reason === "api") vi.mocked(f.browser.currentApiUrl).mockReturnValue("https://other.example.test");
    await expect(route.verifyCurrent()).rejects.toThrow(); expect(route.signal.aborted).toBe(true);
    expect(f.onClosed).toHaveBeenCalledOnce();
  });
  it("cannot resurrect while a browser lookup was pending", async () => {
    const f = fixture(), route = (await f.accept())!;
    let finish!: (value: Awaited<ReturnType<typeof f.browser.getFrames>>) => void;
    vi.mocked(f.browser.getFrames).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const verifying = route.verifyCurrent(); route.close(); finish([f.top, f.bridge]);
    await expect(verifying).rejects.toThrow(); expect(f.onClosed).toHaveBeenCalledOnce();
  });
});
