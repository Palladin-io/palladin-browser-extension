import { describe, expect, it, vi } from "vitest";

import { openSidePanel, supportsSidePanel } from "./side-panel";

describe("side-panel target adapter", () => {
  it("opens Chromium's side panel for the current window", async () => {
    const open = vi.fn(async () => undefined);

    await expect(openSidePanel("chromium", {
      chrome: {
        windows: { WINDOW_ID_CURRENT: -2 },
        sidePanel: { open },
      },
    })).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith({ windowId: -2 });
  });

  it("opens Chromium's panel in the browser-authenticated source window", async () => {
    const open = vi.fn(async () => undefined);

    await expect(openSidePanel("chromium", {
      chrome: {
        windows: { WINDOW_ID_CURRENT: -2 },
        sidePanel: { open },
      },
    }, 42)).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  it("uses Firefox's sidebarAction without sharing platform-specific logic", async () => {
    const open = vi.fn(async () => undefined);

    await expect(openSidePanel("firefox", {
      browser: { sidebarAction: { open } },
    })).resolves.toBe(true);

    expect(open).toHaveBeenCalledOnce();
  });

  it("fails honestly when a target or runtime API has no side panel", async () => {
    expect(supportsSidePanel("chromium")).toBe(true);
    expect(supportsSidePanel("firefox")).toBe(true);
    expect(supportsSidePanel("safari")).toBe(false);
    await expect(openSidePanel("safari", {})).resolves.toBe(false);
    await expect(openSidePanel("chromium", {})).resolves.toBe(false);
  });
});
