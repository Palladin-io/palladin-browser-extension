import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startChromiumSharedUnlockBrowser } from "./chromium-browser";
import { SHARED_UNLOCK_BROWSER_PORT } from "../../shared/messaging/shared-unlock-browser";
vi.mock("@palladin/crypto", () => ({ randomBytes: async () => new Uint8Array(32), toBase64Url: () => "A".repeat(43) }));

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return { addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    emit: (...args: T) => { for (const listener of [...listeners]) listener(...args); }, listeners };
}
const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
const hello = { type: "hello", protocol: SHARED_UNLOCK_BROWSER_PORT, apiUrl: environments[0].apiUrl, webNonce: "A".repeat(43) };
const navigation = { tabId: 7, frameId: 0, documentId: "document-1", documentLifecycle: "active" };
function fixture(initialize?: () => Promise<unknown>) {
  const api = { runtime: { id: "a".repeat(32), onConnectExternal: event<[chrome.runtime.Port]>() },
    tabs: { get: vi.fn(async (id: number) => ({ id, incognito: false })), onRemoved: event<[number]>() },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: "document-1", documentLifecycle: "active", frameType: "outermost_frame", parentFrameId: -1, errorOccurred: false, url: environments[0].webOrigin })),
      onBeforeNavigate: event<[typeof navigation]>(), onCommitted: event<[typeof navigation]>(), onErrorOccurred: event<[typeof navigation]>(),
      onTabReplaced: event<[{ replacedTabId: number; tabId: number }]>() } };
  vi.stubGlobal("chrome", api);
  const controller = startChromiumSharedUnlockBrowser(environments, () => environments[0].apiUrl, initialize);
  const port = (tabId = 7) => {
    const connection = { name: SHARED_UNLOCK_BROWSER_PORT, sender: { tab: { id: tabId, incognito: false }, frameId: 0,
      documentId: "document-1", documentLifecycle: "active", origin: environments[0].webOrigin, url: environments[0].webOrigin },
      onMessage: event<[unknown]>(), onDisconnect: event<[]>(), postMessage: vi.fn(), disconnect: vi.fn() };
    // Local disconnect intentionally does NOT emit onDisconnect, matching the browser API.
    api.runtime.onConnectExternal.emit(connection as unknown as chrome.runtime.Port);
    return connection;
  };
  return { api, controller, port };
}
async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Chromium shared unlock runtime channel", () => {
  it("uses current top-frame browser lookup and sends only the bounded ready frame", async () => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(hello); await settle();
    expect(f.api.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    expect(p.postMessage).toHaveBeenCalledWith({ ...hello, type: "ready", webOrigin: environments[0].webOrigin,
      extensionId: "a".repeat(32), channelId: "A".repeat(43), documentBinding: `7/document-1/${"A".repeat(43)}` });
    expect(f.controller.routes()).toHaveLength(1); await vi.advanceTimersByTimeAsync(6000); expect(p.disconnect).not.toHaveBeenCalled(); f.controller.close();
  });
  it.each([null, { ...hello, apiUrl: "https://wrong.example.test" }, { ...hello, token: "synthetic" }])("rejects invalid hello %#", async raw => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(raw); await settle();
    expect(p.postMessage).not.toHaveBeenCalled(); expect(p.disconnect).toHaveBeenCalled(); expect(p.onMessage.listeners.size).toBe(0); f.controller.close();
  });
  it("rejects repeated hello and disposes local listeners", async () => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(hello); await settle(); p.onMessage.emit(hello);
    expect(f.controller.routes()).toHaveLength(0); expect(p.onMessage.listeners.size).toBe(0); expect(p.onDisconnect.listeners.size).toBe(0); f.controller.close();
  });
  it("times out an idle Port without relying on a local disconnect event", async () => {
    const f = fixture(); const p = f.port(); await vi.advanceTimersByTimeAsync(5000);
    expect(p.disconnect).toHaveBeenCalledOnce(); expect(p.onMessage.listeners.size).toBe(0); f.controller.close();
  });
  it.each(["close", "suspend", "timeout", "peer"])("cannot finish pending initialization after %s", async reason => {
    let finish!: () => void; const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }));
    const p = f.port(); p.onMessage.emit(hello);
    if (reason === "close") f.controller.close();
    if (reason === "suspend") f.controller.suspend()();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(5000);
    if (reason === "peer") p.onDisconnect.emit();
    finish(); await settle(); expect(p.postMessage).not.toHaveBeenCalled(); expect(f.controller.routes()).toHaveLength(0); f.controller.close();
  });
  it("retires at navigation start, denies the navigating document, then accepts a fresh committed document", async () => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(hello); await settle(); const old = f.controller.routes()[0];
    f.api.webNavigation.onBeforeNavigate.emit(navigation); expect(() => old.assertCurrent()).toThrow();
    const stale = f.port(); stale.onMessage.emit(hello); await settle(); expect(stale.postMessage).not.toHaveBeenCalled();
    f.api.webNavigation.onCommitted.emit({ ...navigation, documentId: "document-2" });
    const next = f.port(); next.sender.documentId = "document-2";
    f.api.webNavigation.getFrame.mockResolvedValue({ ...(await f.api.webNavigation.getFrame()), documentId: "document-2" });
    next.onMessage.emit(hello); await settle(); expect(next.postMessage).toHaveBeenCalledOnce(); f.controller.close();
  });
  it("ignores subframe navigation and preserves a same-document commit", async () => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(hello); await settle();
    f.api.webNavigation.onBeforeNavigate.emit({ ...navigation, frameId: 2 }); f.api.webNavigation.onCommitted.emit(navigation);
    expect(p.disconnect).not.toHaveBeenCalled(); f.controller.close();
  });
  it.each(["commit", "error", "replacement", "removal"])("retires only affected routes on %s", async reason => {
    const f = fixture(); const p = f.port(); const other = f.port(8); p.onMessage.emit(hello); other.onMessage.emit(hello); await settle();
    if (reason === "commit") f.api.webNavigation.onCommitted.emit({ ...navigation, documentId: "other" });
    if (reason === "error") f.api.webNavigation.onErrorOccurred.emit(navigation);
    if (reason === "replacement") f.api.webNavigation.onTabReplaced.emit({ replacedTabId: 7, tabId: 9 });
    if (reason === "removal") f.api.tabs.onRemoved.emit(7);
    expect(p.disconnect).toHaveBeenCalled(); expect(other.disconnect).not.toHaveBeenCalled(); expect(f.controller.routes()).toHaveLength(1); f.controller.close();
  });
  it("replaces a Port on the same document without resurrecting its previous route", async () => {
    const f = fixture(); const first = f.port(); first.onMessage.emit(hello); await settle(); const old = f.controller.routes()[0];
    const second = f.port(); second.onMessage.emit(hello); await settle(); expect(first.disconnect).toHaveBeenCalled();
    expect(second.postMessage).toHaveBeenCalledOnce(); expect(f.controller.routes()).toHaveLength(1); expect(() => old.assertCurrent()).toThrow(); f.controller.close();
  });
  it("bounds pending handshakes and releases capacity on timeout", async () => {
    const f = fixture(); for (let i = 0; i < 64; i += 1) f.port(i);
    const denied = f.port(65); expect(denied.disconnect).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); const accepted = f.port(); accepted.onMessage.emit(hello); await settle();
    expect(accepted.postMessage).toHaveBeenCalledOnce(); f.controller.close();
  });
  it("keeps admission closed until all overlapping server changes finish", async () => {
    const f = fixture(); const p = f.port(); p.onMessage.emit(hello); await settle(); const old = f.controller.routes()[0];
    const first = f.controller.suspend(); const second = f.controller.suspend(); first(); first();
    const denied = f.port(); expect(denied.disconnect).toHaveBeenCalled(); second();
    const fresh = f.port(); fresh.onMessage.emit(hello); await settle(); expect(fresh.postMessage).toHaveBeenCalledOnce();
    expect(() => old.assertCurrent()).toThrow(); f.controller.close(); expect(f.api.runtime.onConnectExternal.listeners.size).toBe(0);
  });
});
