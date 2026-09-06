// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClosedSurface } from "./closed-surface";

describe("closed capture surface interaction boundary", () => {
  let surface: ReturnType<typeof createClosedSurface>;
  let button: HTMLButtonElement;
  const event = { isTrusted: true, detail: 1, clientX: 100, clientY: 40 } as MouseEvent;

  beforeEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll("palladin-capture").forEach((element) => element.remove());
    surface = createClosedSurface(document, "palladin-capture");
    surface.host.style.setProperty("pointer-events", "auto", "important");
    button = document.createElement("button");
    button.textContent = "Save";
    surface.shadow.append(button);
    document.documentElement.append(surface.host);
    vi.spyOn(surface.host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 80));
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => surface.host) });
    Object.defineProperty(surface.shadow, "elementFromPoint", { configurable: true, value: vi.fn(() => button) });
  });
  it("accepts a trusted pointer action on a topmost visible control", () => {
    expect(surface.acceptsAction(event, button)).toBe(true);
  });
  it("rejects script-dispatched events", () => {
    expect(surface.acceptsAction(new MouseEvent("click"), button)).toBe(false);
  });
  it("rejects overlay clickjacking", () => {
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    expect(surface.acceptsAction(event, button)).toBe(false);
  });
  it("rejects hidden, transparent and detached surfaces", () => {
    surface.host.style.setProperty("opacity", "0", "important");
    expect(surface.acceptsAction(event, button)).toBe(false);
    surface.host.style.removeProperty("opacity");
    surface.host.hidden = true;
    expect(surface.acceptsAction(event, button)).toBe(false);
    surface.host.hidden = false;
    surface.host.remove();
    expect(surface.acceptsAction(event, button)).toBe(false);
  });
  it("requires focus inside the protected control for keyboard activation", () => {
    const keyboard = { ...event, detail: 0 } as MouseEvent;
    expect(surface.acceptsAction(keyboard, button)).toBe(false);
    button.focus();
    expect(surface.acceptsAction(keyboard, button)).toBe(true);
  });
  it("rejects a pointer landing on another control", () => {
    vi.mocked(surface.shadow.elementFromPoint).mockReturnValue(surface.host);
    expect(surface.acceptsAction(event, button)).toBe(false);
  });
});
