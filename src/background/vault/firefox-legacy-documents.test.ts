import { afterEach, describe, expect, it, vi } from "vitest";
import { FirefoxLegacyDocuments } from "./firefox-legacy-documents";
import { FIREFOX_LEGACY_FILL_PORT } from "../../shared/messaging/firefox-legacy-fill";
import { FILL_REQUEST_CHANNEL, type FillRequestMessage } from "@shared/messaging";
const marker = "a".repeat(32), origin = "https://login.example.test";
function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return { addListener: (f: (...args: T) => void) => listeners.add(f), removeListener: (f: (...args: T) => void) => listeners.delete(f),
    emit: (...args: T) => { for (const f of [...listeners]) f(...args); } };
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture() {
  const tab = { id: 7, url: origin + "/login", incognito: false, status: "complete" } as chrome.tabs.Tab;
  const browser = { extensionId: "extension@test.invalid", getBrowserInfo: vi.fn(async () => ({ name: "Firefox", version: "140.0" })),
    getTab: vi.fn(async () => tab), probeCurrent: vi.fn(async (_tabId: number): Promise<unknown> => ({ url: tab.url, documentId: marker })) };
  const registry = new FirefoxLegacyDocuments(browser);
  const makePort = () => {
    const sent: unknown[] = [];
    return { name: FIREFOX_LEGACY_FILL_PORT, sender: { id: browser.extensionId, frameId: 0, url: tab.url!, origin, tab },
      sent, postMessage: vi.fn((raw: unknown) => { sent.push(structuredClone(raw)); }), disconnect: vi.fn(),
      onMessage: event<[unknown]>(), onDisconnect: event<[]>() };
  };
  const port = makePort();
  const register = async (candidate = port) => {
    registry.register(candidate as unknown as chrome.runtime.Port);
    candidate.onMessage.emit({ type: "hello", documentId: marker }); await settle();
  };
  const request: FillRequestMessage = { channel: FILL_REQUEST_CHANNEL, documentId: marker, expectedOrigin: origin,
    expectedDomain: "login.example.test", submit: false, loginTargetId: "form-1", fields: [{ kind: "password", value: "synthetic" }] };
  return { browser, tab, registry, port, register, makePort, request };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("legacy Firefox exact original document Port", () => {
  it("probes without a secret, then sends the password only over the original private Port", async () => {
    const f = fixture(); await f.register(); const target = (await f.registry.resolve(7))!;
    expect(target).toMatchObject({ documentTransport: "legacy-firefox-port", documentId: marker });
    expect(target.browserDocumentId).toBeUndefined();
    const result = f.registry.send(target, f.request, () => undefined); await settle();
    const fill = f.port.sent.find((value): value is { type: string; requestId: string; request: FillRequestMessage } => (value as { type: string }).type === "fill")!;
    expect(fill.request.fields[0].value).toBe("synthetic"); expect(f.request.fields[0].value).toBe("synthetic");
    expect(f.browser.probeCurrent.mock.calls.every(args => args.length === 1 && args[0] === 7)).toBe(true);
    f.port.onMessage.emit({ type: "result", requestId: fill.requestId, outcome: { ok: true } });
    expect(await result).toEqual({ ok: true });
  });
  it.each(["modern", "old", "other-browser", "wrong-id", "subframe", "incognito", "insecure", "native-id"])("rejects %s registration", async reason => {
    const f = fixture();
    if (reason === "modern") f.browser.getBrowserInfo.mockResolvedValue({ name: "Firefox", version: "155.0" });
    if (reason === "old") f.browser.getBrowserInfo.mockResolvedValue({ name: "Firefox", version: "139.0" });
    if (reason === "other-browser") f.browser.getBrowserInfo.mockResolvedValue({ name: "Chromium", version: "140.0" });
    if (reason === "wrong-id") f.port.sender.id = "other@test.invalid";
    if (reason === "subframe") f.port.sender.frameId = 1;
    if (reason === "incognito") f.tab.incognito = true;
    if (reason === "insecure") f.port.sender.url = "http://login.example.test";
    if (reason === "native-id") Object.assign(f.port.sender, { documentId: "native" });
    await f.register(); expect(await f.registry.resolve(7)).toBeNull(); expect(f.port.disconnect).toHaveBeenCalled();
  });
  it.each(["marker", "origin", "loading", "discarded", "frozen", "pending"])("sends no password after current %s changed", async reason => {
    const f = fixture(); await f.register(); const target = (await f.registry.resolve(7))!;
    if (reason === "marker") f.browser.probeCurrent.mockResolvedValue({ url: f.tab.url, documentId: "b".repeat(32) });
    if (reason === "origin") f.tab.url = "https://other.example.test";
    if (reason === "loading") f.tab.status = "loading";
    if (reason === "discarded") f.tab.discarded = true;
    if (reason === "frozen") Object.assign(f.tab, { frozen: true });
    if (reason === "pending") f.tab.pendingUrl = f.tab.url!;
    expect(await f.registry.send(target, f.request, () => undefined)).toEqual({ ok: false, reason: "target-changed" });
    expect(f.port.sent).toEqual([{ type: "ready" }]);
  });
  it("retires pending registration when navigation precedes its browser response", async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.browser.probeCurrent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.register(); f.registry.retire(7); finish({ url: f.tab.url, documentId: marker }); await settle();
    expect(await f.registry.resolve(7)).toBeNull(); expect(f.port.sent).toEqual([]);
  });
  it("does not deliver a secret after navigation during a matching browser read", async () => {
    const f = fixture(); await f.register(); const target = (await f.registry.resolve(7))!;
    let finish!: (value: unknown) => void;
    f.browser.probeCurrent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = f.registry.send(target, f.request, () => undefined); f.registry.retire(7); finish({ url: f.tab.url, documentId: marker });
    expect(await result).toEqual({ ok: false, reason: "target-changed" }); expect(f.port.sent).toEqual([{ type: "ready" }]);
  });
  it("a restored/reconnected document cannot reuse its old registration even with the same marker", async () => {
    const f = fixture(); await f.register(); const old = (await f.registry.resolve(7))!;
    f.port.onDisconnect.emit(); const fresh = f.makePort(); await f.register(fresh);
    expect((await f.registry.resolve(7))!.legacyFirefoxRouteId).not.toBe(old.legacyFirefoxRouteId);
    expect(await f.registry.send(old, f.request, () => undefined)).toEqual({ ok: false, reason: "target-changed" });
    expect(fresh.sent).toEqual([{ type: "ready" }]);
  });
  it("does not accept a forged command marker as current-document authority", async () => {
    const f = fixture(); await f.register();
    expect(await f.registry.resolveSource("b".repeat(32), f.port.sender)).toBeNull();
    expect(await f.registry.resolveSource(marker, f.port.sender)).not.toBeNull();
    expect(await f.registry.resolveSource(marker, { ...f.port.sender, id: "other@test.invalid" })).toBeNull();
  });
  it("expires a hung fill without retaining a queued payload or accepting its late result", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.register(); const target = (await f.registry.resolve(7))!;
    const result = f.registry.send(target, f.request, () => undefined); await settle(); await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ ok: false, reason: "target-changed" }); expect(await f.registry.resolve(7)).toBeNull();
    expect(f.port.disconnect).toHaveBeenCalled();
  });
  it("sends no password when the session changes during current-document verification", async () => {
    const f = fixture(); await f.register(); const target = (await f.registry.resolve(7))!;
    let finish!: (value: unknown) => void;
    f.browser.probeCurrent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let current = true;
    const result = f.registry.send(target, f.request, () => { if (!current) throw new Error("Session changed"); });
    current = false; finish({ url: f.tab.url, documentId: marker });
    expect(await result).toEqual({ ok: false, reason: "target-changed" });
    expect(f.port.sent).toEqual([{ type: "ready" }]);
  });
});
