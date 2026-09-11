import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSafariSharedUnlockBrowser } from "./safari-browser";
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
const navigation = { tabId: 7, frameId: 0, documentId: "11111111-1111-4111-8111-111111111111" };
function fixture(initialize?: () => Promise<unknown>, onReady?: Parameters<typeof startSafariSharedUnlockBrowser>[3]) {
  const api = { runtime: { id: "com.example.Extension (ABCDEFGHIJ)", getURL: () => "safari-web-extension://33333333-3333-4333-8333-333333333333/", onConnectExternal: event<[chrome.runtime.Port]>() },
    tabs: { get: vi.fn(async (id: number) => ({ id, incognito: false, status: "complete", url: environments[0].webOrigin })), onRemoved: event<[number]>() },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: "11111111-1111-4111-8111-111111111111", parentFrameId: -1, errorOccurred: false, url: environments[0].webOrigin })),
      onBeforeNavigate: event<[typeof navigation]>(), onCommitted: event<[typeof navigation]>(), onErrorOccurred: event<[typeof navigation]>(),
      onTabReplaced: event<[{ replacedTabId: number; tabId: number }]>() } };
  vi.stubGlobal("browser", api);
  vi.stubGlobal("chrome", { runtime: { onConnectExternal: { addListener: () => { throw new Error("Wrong native namespace"); } } } });
  const controller = startSafariSharedUnlockBrowser(environments, () => environments[0].apiUrl, initialize, onReady)!;
  const port = (tabId = 7) => {
    const connection = { name: SHARED_UNLOCK_BROWSER_PORT, sender: { tab: { id: tabId, incognito: false, url: environments[0].webOrigin }, frameId: 0,
      documentId: "11111111-1111-4111-8111-111111111111", origin: environments[0].webOrigin, url: environments[0].webOrigin },
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

describe("Safari native external Port adapter", () => {
  it("uses the Safari namespace and sends a ready frame bound to the native document", async () => {
    const ready = vi.fn(), f = fixture(undefined, ready), p = f.port();
    p.onMessage.emit(hello); await settle();
    expect(p.postMessage).toHaveBeenCalledWith({ ...hello, type: "ready", webOrigin: environments[0].webOrigin,
      extensionId: f.api.runtime.id, channelId: "A".repeat(43),
      documentBinding: `7/${navigation.documentId}/${"A".repeat(43)}` });
    expect(ready).toHaveBeenCalledOnce(); expect(f.api.webNavigation.getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    f.controller.close();
  });
  it.each(["navigation", "commit", "removal", "replacement", "error"])("cannot revive a pending handshake after %s", async reason => {
    let finish!: () => void; const f = fixture(() => new Promise<void>(resolve => { finish = resolve; })), p = f.port();
    p.onMessage.emit(hello);
    if (reason === "navigation") f.api.webNavigation.onBeforeNavigate.emit(navigation);
    if (reason === "commit") f.api.webNavigation.onCommitted.emit({ ...navigation, documentId: "22222222-2222-4222-8222-222222222222" });
    if (reason === "removal") f.api.tabs.onRemoved.emit(7);
    if (reason === "replacement") f.api.webNavigation.onTabReplaced.emit({ replacedTabId: 7, tabId: 9 });
    if (reason === "error") f.api.webNavigation.onErrorOccurred.emit(navigation);
    finish(); await settle(); expect(p.postMessage).not.toHaveBeenCalled(); expect(p.disconnect).toHaveBeenCalledOnce();
    expect(f.controller.routes()).toHaveLength(0); f.controller.close();
  });
  it("closes an operation when the independent current document changes", async () => {
    const received = vi.fn(), f = fixture(undefined, route => route.onOperation(received)), p = f.port();
    p.onMessage.emit(hello); await settle(); const route = f.controller.routes()[0];
    const frame = { ...hello, type: "operation", channelId: route.channelId, documentBinding: route.documentBinding,
      attemptId: "A".repeat(43), payload: { kind: "cancel" } };
    f.api.webNavigation.getFrame.mockResolvedValue({ ...(await f.api.webNavigation.getFrame()), documentId: "22222222-2222-4222-8222-222222222222" });
    p.onMessage.emit(frame); await settle(); expect(received).not.toHaveBeenCalled(); expect(route.signal.aborted).toBe(true); f.controller.close();
  });
  it("preserves a same-document commit without inventing Chromium lifecycle fields", async () => {
    const f = fixture(), p = f.port(); p.onMessage.emit(hello); await settle();
    f.api.webNavigation.onCommitted.emit(navigation); expect(p.disconnect).not.toHaveBeenCalled();
    f.controller.close(); expect(p.disconnect).toHaveBeenCalledOnce();
  });
  it.each(["runtime", "tabs", "webNavigation", "navigation-event"])("disables the adapter if Safari lacks %s", missing => {
    const f = fixture(); f.controller.close();
    if (missing === "navigation-event") Object.assign(f.api.webNavigation, { onBeforeNavigate: undefined });
    else Object.assign(f.api, { [missing]: undefined });
    expect(startSafariSharedUnlockBrowser(environments, () => environments[0].apiUrl)).toBeNull();
  });
});
