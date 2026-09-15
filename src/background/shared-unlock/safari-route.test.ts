import { afterEach, describe, expect, it, vi } from "vitest";
import { SafariSharedUnlockRoute, type SafariSharedUnlockBrowserApi } from "./safari-route";
import { SHARED_UNLOCK_BROWSER_PORT } from "../../shared/messaging/shared-unlock-browser";

const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
function fixture() {
  const tab = { id: 7, incognito: false, discarded: false, status: "complete", url: environments[0].webOrigin + "/vaults" } as chrome.tabs.Tab;
  const frame = { documentId: "11111111-1111-4111-8111-111111111111", parentFrameId: -1,
    errorOccurred: false, url: environments[0].webOrigin + "/vaults" } as chrome.webNavigation.GetFrameResultDetails;
  const sender: chrome.runtime.MessageSender = { tab, frameId: 0, documentId: frame.documentId,
    origin: environments[0].webOrigin, url: frame.url };
  const port = { sender, disconnect: vi.fn(), postMessage: vi.fn() } as unknown as chrome.runtime.Port;
  const browser: SafariSharedUnlockBrowserApi = { extensionId: "com.example.Extension (ABCDEFGHIJ)", extensionUrl: vi.fn(() => "safari-web-extension://33333333-3333-4333-8333-333333333333/"), currentApiUrl: vi.fn(() => environments[0].apiUrl),
    getTab: vi.fn(async () => tab), getFrame: vi.fn(async () => frame) };
  const onClosed = vi.fn();
  return { tab, frame, sender, port, browser, onClosed,
    accept: () => SafariSharedUnlockRoute.accept(port, browser, environments, "A".repeat(43), onClosed) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Safari native external sender and current document authority", () => {
  it("binds the configured pair, browser tab and document; same-document history is allowed", async () => {
    const f = fixture(); const route = f.accept()!;
    expect(route.documentBinding).toBe(`7/11111111-1111-4111-8111-111111111111/${"A".repeat(43)}`);
    await route.verifyCurrent(); f.frame.url = environments[0].webOrigin + "/other#hash";
    await route.verifyCurrent(); expect(f.onClosed).not.toHaveBeenCalled();
  });
  it.each([
    ["external extension", { id: "a".repeat(32) }], ["native application", { nativeApplication: "host" }],
    ["iframe", { frameId: 2 }], ["prerender", { documentLifecycle: "prerender" }],
    ["cached", { documentLifecycle: "cached" }], ["missing document", { documentId: undefined }],
    ["malformed document", { documentId: "page-chosen-id" }],
    ["oversized document", { documentId: "a".repeat(129) }], ["missing tab", { tab: undefined }],
    ["incognito", { tab: { id: 7, incognito: true } }], ["missing incognito flag", { tab: { id: 7 } }],
    ["negative tab", { tab: { id: -1, incognito: false } }], ["fractional tab", { tab: { id: 0.5, incognito: false } }],
    ["other origin", { origin: "https://evil.example.test" }], ["wrong port", { origin: "https://app.example.test" }],
    ["opaque origin", { origin: "null" }], ["mismatched URL", { url: "https://evil.example.test" }],
    ["credential URL", { url: "https://name@app.example.test:8443" }], ["invalid URL", { url: "://" }],
  ])("rejects %s before a browser query", (_name, patch) => {
    const f = fixture(); Object.assign(f.sender, patch); expect(f.accept()).toBeNull(); expect(f.browser.getFrame).not.toHaveBeenCalled();
  });
  it("requires the independently configured current API", () => {
    const f = fixture(); vi.mocked(f.browser.currentApiUrl).mockReturnValue("https://other.example.test"); expect(f.accept()).toBeNull();
  });
  it.each([
    ["new document", { documentId: "22222222-2222-4222-8222-222222222222" }], ["cached", { documentLifecycle: "cached" }],
    ["prerender", { documentLifecycle: "prerender" }], ["inner frame", { frameType: "sub_frame" }],
    ["parent", { parentFrameId: 1 }], ["error", { errorOccurred: true }],
    ["different origin", { url: "https://other.example.test" }], ["different port", { url: "https://app.example.test" }],
  ])("retires when the current top frame reports %s", async (_name, patch) => {
    const f = fixture(); const route = f.accept()!; Object.assign(f.frame, patch);
    await expect(route.verifyCurrent()).rejects.toThrow(); expect(() => route.assertCurrent()).toThrow(); expect(f.onClosed).toHaveBeenCalledOnce();
  });
  it.each([
    ["different tab", { id: 8 }], ["loading", { status: "loading" }], ["missing status", { status: undefined }],
    ["wrong tab origin", { url: "https://other.test" }], ["missing tab URL", { url: undefined }], ["missing incognito", { incognito: undefined }], ["incognito", { incognito: true }], ["discarded", { discarded: true }],
    ["frozen", { frozen: true }], ["pending navigation", { pendingUrl: environments[0].webOrigin }],
  ])("retires on %s", async (_name, patch) => {
    const f = fixture(); const route = f.accept()!; Object.assign(f.tab, patch); await expect(route.verifyCurrent()).rejects.toThrow();
  });
  it.each([null, undefined])("retires when no current frame exists (%s)", async frame => {
    const f = fixture(); const route = f.accept()!; vi.mocked(f.browser.getFrame).mockResolvedValue(frame);
    await expect(route.verifyCurrent()).rejects.toThrow();
  });
  it("does not resurrect a route after navigation while browser reads were pending", async () => {
    const f = fixture(); const route = f.accept()!;
    let finish!: (value: chrome.webNavigation.GetFrameResultDetails) => void;
    vi.mocked(f.browser.getFrame).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const verification = route.verifyCurrent(); route.close(); finish(f.frame);
    await expect(verification).rejects.toThrow(); expect(f.onClosed).toHaveBeenCalledOnce();
  });
  it("permanently retires on observed API change", () => {
    const f = fixture(); const route = f.accept()!; vi.mocked(f.browser.currentApiUrl).mockReturnValue("https://other.example.test");
    expect(() => route.assertCurrent()).toThrow(); vi.mocked(f.browser.currentApiUrl).mockReturnValue(environments[0].apiUrl);
    expect(() => route.assertCurrent()).toThrow();
  });
  it("never sends a payload outside the typed browser vocabulary", () => {
    const f = fixture(); const route = f.accept()!;
    const hello = { type: "hello" as const, protocol: SHARED_UNLOCK_BROWSER_PORT, apiUrl: environments[0].apiUrl, webNonce: "A".repeat(43) } as const;
    const invalid = { ...hello, accessToken: "synthetic" };
    expect(() => route.post(invalid)).toThrow();
    expect(f.port.postMessage).not.toHaveBeenCalled(); route.post(hello); expect(f.port.postMessage).toHaveBeenCalledOnce();
  });
});

it.each(["com.example.Extension", "com.example.Extension%20(ABCDEFGHIJ)", "a".repeat(32)])("rejects a non-Safari native identity %s", extensionId => {
  const f = fixture(); Object.assign(f.browser, { extensionId }); expect(f.accept()).toBeNull();
});
it.each(["https://app.example.test/", "safari-web-extension://page-chosen-id/", "safari-web-extension://33333333-3333-4333-8333-333333333333/?claim=1"])("rejects an invalid native installation URL %s", url => {
  const f = fixture(); vi.mocked(f.browser.extensionUrl).mockReturnValue(url); expect(f.accept()).toBeNull();
});
it("retires permanently when the native installation changes during a document lookup", async () => {
  const f = fixture(), route = f.accept()!;
  vi.mocked(f.browser.getFrame).mockImplementation(async () => {
    vi.mocked(f.browser.extensionUrl).mockReturnValue("safari-web-extension://44444444-4444-4444-8444-444444444444/");
    return f.frame;
  });
  await expect(route.verifyCurrent()).rejects.toThrow(); expect(route.signal.aborted).toBe(true);
});
it("bounds stalled native lookups and ignores their late completion", async () => {
  vi.useFakeTimers(); const f = fixture(), route = f.accept()!;
  let finish!: (value: chrome.webNavigation.GetFrameResultDetails) => void;
  vi.mocked(f.browser.getFrame).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const verified = expect(route.verifyCurrent()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2000); await verified;
  finish(f.frame); await Promise.resolve(); expect(route.signal.aborted).toBe(true); expect(f.onClosed).toHaveBeenCalledOnce();
});
it.each([-1, 2000])("rejects a native lookup crossing the wall-clock boundary %s", elapsed => {
  const f = fixture(), route = f.accept()!;
  const started = Date.now(); vi.spyOn(Date, "now").mockReturnValueOnce(started).mockReturnValue(started + elapsed);
  return expect(route.verifyCurrent()).rejects.toThrow();
});
