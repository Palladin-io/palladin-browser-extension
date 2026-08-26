import { describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_PAGE_PATH,
  openOnboardingAfterInstall,
  shouldOpenOnboarding,
  type OnboardingTabApi,
} from "./onboarding";

function details(reason: "install" | "update"): chrome.runtime.InstalledDetails {
  return { reason: reason as chrome.runtime.OnInstalledReason };
}

describe("extension onboarding install hook", () => {
  it("opens the full-page onboarding after a fresh install", async () => {
    const openTab = vi.fn().mockResolvedValue({});
    const api: OnboardingTabApi = {
      getUrl: (path) => `chrome-extension://palladin/${path}`,
      openTab,
    };

    await openOnboardingAfterInstall(details("install"), api);

    expect(openTab).toHaveBeenCalledWith({
      url: `chrome-extension://palladin/${ONBOARDING_PAGE_PATH}`,
      active: true,
    });
  });

  it("does not interrupt browser updates", async () => {
    const api: OnboardingTabApi = {
      getUrl: vi.fn(),
      openTab: vi.fn(),
    };

    await openOnboardingAfterInstall(details("update"), api);

    expect(api.getUrl).not.toHaveBeenCalled();
    expect(api.openTab).not.toHaveBeenCalled();
  });

  it("recognises only a fresh install", () => {
    expect(shouldOpenOnboarding(details("install"))).toBe(true);
    expect(shouldOpenOnboarding(details("update"))).toBe(false);
  });
});
