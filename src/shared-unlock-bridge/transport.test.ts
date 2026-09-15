import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFirefoxSharedUnlockBridge } from "./transport";
import { SHARED_UNLOCK_BROWSER_PORT } from "../shared/messaging/shared-unlock-browser";
import { FIREFOX_SHARED_UNLOCK_CLOSED } from "../shared/messaging/shared-unlock-firefox";
import { FIREFOX_CURRENT_DOCUMENT, FIREFOX_DOCUMENT_BINDING } from "../shared/messaging/shared-unlock-firefox-document";

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (listener: (value: T) => void) => listeners.add(listener),
    removeListener: (listener: (value: T) => void) => listeners.delete(listener),
    emit: (value: T) => { for (const listener of [...listeners]) listener(value); } };
}
const environments = [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test:8443" }];
const hello = { type: "hello", protocol: SHARED_UNLOCK_BROWSER_PORT, apiUrl: environments[0].apiUrl, webNonce: "A".repeat(43) };
const ready = { ...hello, type: "ready", webOrigin: environments[0].webOrigin, extensionId: "browser-extension@palladin.io",
  channelId: "E".repeat(43), documentBinding: "7/top/bridge/" + "E".repeat(43) };
const operation = { ...hello, type: "operation", channelId: ready.channelId, documentBinding: ready.documentBinding,
  attemptId: "A".repeat(43), payload: { kind: "cancel" } };
function fixture() {
  const parent = { postMessage: vi.fn() };
  const target = new EventTarget();
  const owner = Object.assign(target, { parent, top: parent }) as unknown as Window;
  const port = { postMessage: vi.fn(), disconnect: vi.fn(), onMessage: event<unknown>(), onDisconnect: event<void>() };
  const runtime = { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, id: ready.extensionId, connect: vi.fn(() => port as unknown as chrome.runtime.Port) };
  const bridge = startFirefoxSharedUnlockBridge(owner, environments, runtime as unknown as typeof chrome.runtime);
  const send = (data: unknown, patch = {}) => {
    const message = new Event("message");
    Object.assign(message, { data, source: parent, origin: environments[0].webOrigin }, patch);
    target.dispatchEvent(message);
  };
  return { owner, parent, target, port, runtime, bridge, send };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("Firefox own-frame transport boundary", () => {
  it("keeps the document binding on its private Port and answers only own browser messages", () => {
    const f = fixture(); f.send(hello);
    const binding = f.port.postMessage.mock.calls[0][0] as { type: string; marker: string };
    expect(binding.type).toBe(FIREFOX_DOCUMENT_BINDING);
    const listener = f.runtime.onMessage.addListener.mock.calls[0][0];
    const reply = vi.fn(), query = { type: FIREFOX_CURRENT_DOCUMENT };
    listener(query, { id: "other@example.test" }, reply);
    listener(query, { id: ready.extensionId, tab: { id: 7 } }, reply);
    listener({ ...query, marker: binding.marker }, { id: ready.extensionId }, reply);
    expect(reply).not.toHaveBeenCalled();
    listener(query, { id: ready.extensionId }, reply); expect(reply).toHaveBeenCalledExactlyOnceWith({ marker: binding.marker });
    expect(f.parent.postMessage).not.toHaveBeenCalled();
    f.bridge.close(); reply.mockClear(); listener(query, { id: ready.extensionId }, reply);
    expect(reply).not.toHaveBeenCalled(); expect(f.runtime.onMessage.removeListener).toHaveBeenCalledWith(listener);
  });
  it("forwards strict frames only between the exact top Web parent and own private runtime Port", () => {
    const f = fixture(); f.send(hello);
    expect(f.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: SHARED_UNLOCK_BROWSER_PORT });
    expect(f.port.postMessage).toHaveBeenLastCalledWith(hello);
    f.port.onMessage.emit(ready);
    expect(f.parent.postMessage).toHaveBeenLastCalledWith(ready, environments[0].webOrigin);
    f.send(operation); expect(f.port.postMessage).toHaveBeenLastCalledWith(operation);
    f.port.onMessage.emit(operation); expect(f.parent.postMessage).toHaveBeenLastCalledWith(operation, environments[0].webOrigin);
    f.bridge.close();
  });
  it.each([{ source: {} }, { source: null }, { origin: "null" }, { origin: "https://app.example.test" },
    { origin: "https://evil.example.test" }])("ignores an untrusted browser message source %#", patch => {
    const f = fixture(); f.send(hello, patch); expect(f.runtime.connect).not.toHaveBeenCalled(); f.bridge.close();
  });
  it("does not permit nested embedding even by a configured Web origin", () => {
    const f = fixture(); Object.assign(f.owner, { top: {} }); f.send(hello);
    expect(f.runtime.connect).not.toHaveBeenCalled(); f.bridge.close();
  });
  it.each([{ ...hello, apiUrl: "https://other.example.test" }, { ...hello, key: "synthetic" }, operation, ready])(
    "denies invalid initial parent framing %#", raw => {
      const f = fixture(); f.send(raw); expect(f.runtime.connect).not.toHaveBeenCalled(); f.send(hello);
      expect(f.runtime.connect).not.toHaveBeenCalled();
    });
  it.each([{ ...ready, extensionId: "other@example.test" }, { ...ready, webOrigin: "https://app.example.test" },
    { ...ready, webNonce: "E".repeat(43) }, { ...ready, key: "synthetic" }, hello, operation])(
    "retires on invalid worker ready framing %#", raw => {
      const f = fixture(); f.send(hello); f.port.onMessage.emit(raw);
      expect(f.port.disconnect).toHaveBeenCalledOnce();
      expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: FIREFOX_SHARED_UNLOCK_CLOSED }, environments[0].webOrigin);
    });
  it.each(["repeated-hello", "early-operation", "pagehide", "timeout", "port-loss"])("retires on %s and discards late frames", reason => {
    const f = fixture(); f.send(hello);
    if (reason === "repeated-hello") f.send(hello);
    if (reason === "early-operation") f.send(operation);
    if (reason === "pagehide") f.target.dispatchEvent(new Event("pagehide"));
    if (reason === "timeout") vi.advanceTimersByTime(5000);
    if (reason === "port-loss") f.port.onDisconnect.emit();
    f.port.onMessage.emit(ready); f.send(operation);
    expect(f.port.disconnect).toHaveBeenCalledOnce(); expect(f.port.postMessage).toHaveBeenCalledTimes(2);
    expect(f.parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: FIREFOX_SHARED_UNLOCK_CLOSED }, environments[0].webOrigin);
  });
});
