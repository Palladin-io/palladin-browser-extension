import { expect, it, vi } from "vitest";
import { startSurfaceActivity } from "./surface-activity";
function harness() {
  const listeners = new Map<string, EventListener>();
  const target = { addEventListener: vi.fn((name: string, listener: EventListener) => { listeners.set(name, listener); }),
    removeEventListener: vi.fn((name: string) => { listeners.delete(name); }) } as unknown as Window;
  let now = 100;
  const send = vi.fn(async () => {});
  const stop = startSurfaceActivity(target, send, () => now);
  const input = (name: string, trusted: boolean) => listeners.get(name)?.({ isTrusted: trusted } as Event);
  return { target, send, stop, input, setTime: (value: number) => { now = value; }, listeners };
}
it("sends only browser-authored input with the original time, coalesced to once per second", () => {
  const h = harness();
  expect(h.send).not.toHaveBeenCalled();
  h.input("keydown", false); expect(h.send).not.toHaveBeenCalled();
  h.input("keydown", true);
  expect(h.send).toHaveBeenCalledExactlyOnceWith({ channel: "palladin.session/activity", type: "activity", observedAt: 100 });
  for (let i = 0; i < 100; i++) h.input("mousemove", true);
  expect(h.send).toHaveBeenCalledOnce();
  h.setTime(1100); h.input("wheel", true);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.send.mock.calls[1]).toEqual([{ channel: "palladin.session/activity", type: "activity", observedAt: 1100 }]);
  h.stop();
});
it("does not count visibility, pageshow, mount, synthetic input or a retired document", () => {
  const h = harness();
  for (const name of ["pageshow", "visibilitychange", "focus", "load"]) h.input(name, true);
  for (const name of h.listeners.keys()) h.input(name, false);
  expect(h.send).not.toHaveBeenCalled();
  const retained = h.listeners.get("keydown")!;
  h.stop(); retained({ isTrusted: true } as Event);
  expect(h.listeners.size).toBe(0); expect(h.send).not.toHaveBeenCalled();
});
it("does not retry input after a lost worker/context", async () => {
  const h = harness(); h.send.mockRejectedValueOnce(new Error("context gone"));
  h.input("mousedown", true); await Promise.resolve(); await Promise.resolve();
  expect(h.send).toHaveBeenCalledOnce(); h.stop();
});
