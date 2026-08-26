import { describe, expect, it, vi } from "vitest";

import {
  createPasswordManagerOnboardingClient,
  extensionManagerHelpUrl,
  type PasswordManagerOnboardingBrowserApi,
} from "./client";

const STORAGE_KEY = "palladin.onboarding.password-manager-guidance.v1";

function browserApi(
  stored: Record<string, unknown> = {},
): PasswordManagerOnboardingBrowserApi & {
  readonly getLocal: ReturnType<typeof vi.fn>;
  readonly setLocal: ReturnType<typeof vi.fn>;
  readonly openTab: ReturnType<typeof vi.fn>;
} {
  return {
    getLocal: vi.fn(async () => stored),
    setLocal: vi.fn(async () => undefined),
    openTab: vi.fn(async () => undefined),
  };
}

describe("password-manager onboarding client", () => {
  it("is pending only until the versioned local marker is written", async () => {
    const api = browserApi();
    const client = createPasswordManagerOnboardingClient("chromium", api);

    await expect(client.getStatus()).resolves.toBe("pending");
    await client.complete();

    expect(api.getLocal).toHaveBeenCalledWith(STORAGE_KEY);
    expect(api.setLocal).toHaveBeenCalledWith({ [STORAGE_KEY]: true });
  });

  it("does not repeat after the user completed the guidance", async () => {
    const client = createPasswordManagerOnboardingClient(
      "firefox",
      browserApi({ [STORAGE_KEY]: true }),
    );

    await expect(client.getStatus()).resolves.toBe("completed");
  });

  it("opens browser-owned settings without installed-extension access", async () => {
    const api = browserApi();
    const client = createPasswordManagerOnboardingClient("chromium", api);

    await client.openPasswordSettings();
    await client.openExtensionManager();

    expect(api.openTab).toHaveBeenNthCalledWith(1, "chrome://password-manager/settings");
    expect(api.openTab).toHaveBeenNthCalledWith(2, "chrome://extensions/");
  });

  it("falls back to public help when an internal browser page is blocked", async () => {
    const api = browserApi();
    api.openTab.mockRejectedValueOnce(new Error("blocked"));
    const client = createPasswordManagerOnboardingClient("firefox", api);

    await client.openExtensionManager();

    expect(api.openTab).toHaveBeenNthCalledWith(1, "about:addons");
    expect(api.openTab).toHaveBeenNthCalledWith(
      2,
      "https://support.mozilla.org/kb/disable-or-remove-add-ons",
    );
  });

  it("exposes the public extension-manager help link for standalone onboarding", () => {
    expect(extensionManagerHelpUrl("chromium"))
      .toBe("https://support.google.com/chrome_webstore/answer/2664769");
  });
});
