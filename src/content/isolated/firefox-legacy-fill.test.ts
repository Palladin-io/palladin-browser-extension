// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLegacyFirefoxFill } from "./firefox-legacy-fill";
import { FILL_REQUEST_CHANNEL } from "../../shared/messaging/fill";

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return { addListener: (f: (...args: T) => void) => listeners.add(f),
    emit: (...args: T) => { for (const f of [...listeners]) f(...args); } };
}
const documentId = "a".repeat(32);
const stops: Array<() => void> = [];
function fixture() {
  const makePort = () => ({ postMessage: vi.fn(), disconnect: vi.fn(),
    onMessage: event<[unknown]>(), onDisconnect: event<[]>() });
  const ports: ReturnType<typeof makePort>[] = [];
  const connect = vi.fn(() => { const port = makePort(); ports.push(port); return port as unknown as chrome.runtime.Port; });
  const fill = vi.fn(() => ({ ok: true as const })), ready = vi.fn();
  const client = startLegacyFirefoxFill(window, documentId, connect, vi.fn(), fill, ready);
  stops.push(() => client.stop());
  const message = () => ({ type: "fill", requestId: "12345678-1234-1234-1234-123456789abc", issuedAt: Date.now(),
    request: { channel: FILL_REQUEST_CHANNEL, documentId, expectedOrigin: "https://login.example.test",
      expectedDomain: "login.example.test", submit: false, loginTargetId: null,
      fields: [{ kind: "password", value: "synthetic" }] } });
  return { ports, connect, fill, ready, message };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });
describe("private legacy Firefox fill document lifecycle", () => {
  it("fills only after admission and wipes received fields after the synchronous DOM operation", () => {
    const f = fixture(), port = f.ports[0];
    expect(port.postMessage).toHaveBeenCalledWith({ type: "hello", documentId });
    const early = f.message(); port.onMessage.emit(early);
    expect(f.fill).not.toHaveBeenCalled(); expect(early.request.fields[0].value).toBe("");
    port.onMessage.emit({ type: "ready" }); const message = f.message();
    let observed = ""; f.fill.mockImplementationOnce(() => { observed = message.request.fields[0].value; return { ok: true }; });
    port.onMessage.emit(message);
    expect(observed).toBe("synthetic"); expect(message.request.fields[0].value).toBe("");
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "result", requestId: message.requestId, outcome: { ok: true } });
    expect(f.ready).toHaveBeenCalledOnce();
  });
  it.each(["expired", "future", "other-document"])("rejects %s messages before DOM writes", reason => {
    const f = fixture(); f.ports[0].onMessage.emit({ type: "ready" }); const message = f.message();
    if (reason === "expired") message.issuedAt -= 2000;
    if (reason === "future") message.issuedAt += 1;
    if (reason === "other-document") message.request.documentId = "b".repeat(32);
    f.ports[0].onMessage.emit(message);
    expect(f.fill).not.toHaveBeenCalled(); expect(message.request.fields[0].value).toBe("");
  });
  it("drops the old Port on pagehide and admits a fresh Port after BFCache restore", async () => {
    const f = fixture(), old = f.ports[0]; old.onMessage.emit({ type: "ready" });
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await vi.advanceTimersByTimeAsync(1000); expect(f.connect).toHaveBeenCalledOnce();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    const fresh = f.ports[1]; fresh.onMessage.emit({ type: "ready" });
    const late = f.message(); old.onMessage.emit(late); old.onMessage.emit({ forged: true });
    expect(f.fill).not.toHaveBeenCalled(); expect(late.request.fields[0].value).toBe("");
    expect(fresh.disconnect).not.toHaveBeenCalled();
    fresh.onMessage.emit(f.message()); expect(f.fill).toHaveBeenCalledOnce();
  });
  it("reconnects after worker termination and waits for fresh admission", async () => {
    const f = fixture(); f.ports[0].onMessage.emit({ type: "ready" }); f.ports[0].onDisconnect.emit();
    await vi.advanceTimersByTimeAsync(250); expect(f.connect).toHaveBeenCalledTimes(2);
    f.ports[1].onMessage.emit(f.message()); expect(f.fill).not.toHaveBeenCalled();
    f.ports[1].onMessage.emit({ type: "ready" }); f.ports[1].onMessage.emit(f.message());
    expect(f.fill).toHaveBeenCalledOnce(); expect(f.ready).toHaveBeenCalledTimes(2);
  });
  it("does not retry an unsupported browser or relay a page event", async () => {
    const f = fixture(); f.ports[0].onMessage.emit({ type: "unsupported" });
    window.dispatchEvent(new MessageEvent("message", { data: f.message() }));
    f.ports[0].onDisconnect.emit(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.fill).not.toHaveBeenCalled();
  });
});
