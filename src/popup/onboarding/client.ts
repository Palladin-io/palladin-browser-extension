import type { ExtensionBuildTarget } from "@shared/config/build-target";
import { extensionBuildTarget } from "@shared/config/build-target";

export type PasswordManagerOnboardingStatus = "pending" | "completed";

export interface PasswordManagerOnboardingClient {
  getStatus(): Promise<PasswordManagerOnboardingStatus>;
  complete(): Promise<void>;
  openPasswordSettings(): Promise<void>;
  openExtensionManager(): Promise<void>;
}

export interface PasswordManagerOnboardingBrowserApi {
  getLocal(key: string): Promise<Record<string, unknown>>;
  setLocal(items: Record<string, unknown>): Promise<void>;
  openTab(url: string): Promise<void>;
}

const STORAGE_KEY = "palladin.onboarding.password-manager-guidance.v1";

interface PlatformLinks {
  readonly passwords: readonly [primary: string, fallback: string];
  readonly extensions: readonly [primary: string, fallback: string];
}

export function createPasswordManagerOnboardingClient(
  target: ExtensionBuildTarget = extensionBuildTarget,
  api: PasswordManagerOnboardingBrowserApi | null = browserApi(),
): PasswordManagerOnboardingClient {
  const links = platformLinks(target);
  return {
    async getStatus() {
      if (api === null) return "completed";
      const stored = await api.getLocal(STORAGE_KEY);
      return stored[STORAGE_KEY] === true ? "completed" : "pending";
    },
    async complete() {
      await api?.setLocal({ [STORAGE_KEY]: true });
    },
    async openPasswordSettings() {
      if (api === null) throw new Error("browser tabs unavailable");
      await openWithFallback(api, links.passwords);
    },
    async openExtensionManager() {
      if (api === null) throw new Error("browser tabs unavailable");
      await openWithFallback(api, links.extensions);
    },
  };
}

async function openWithFallback(
  api: PasswordManagerOnboardingBrowserApi,
  [primary, fallback]: readonly [string, string],
): Promise<void> {
  try {
    await api.openTab(primary);
  } catch {
    await api.openTab(fallback);
  }
}

function platformLinks(target: ExtensionBuildTarget): PlatformLinks {
  switch (target) {
    case "chromium":
      return {
        passwords: [
          "chrome://password-manager/settings",
          "https://support.google.com/chrome/answer/95606",
        ],
        extensions: [
          "chrome://extensions/",
          "https://support.google.com/chrome_webstore/answer/2664769",
        ],
      };
    case "firefox":
      return {
        passwords: [
          "about:preferences#privacy",
          "https://support.mozilla.org/kb/password-manager-remember-delete-edit-logins",
        ],
        extensions: [
          "about:addons",
          "https://support.mozilla.org/kb/disable-or-remove-add-ons",
        ],
      };
    case "safari":
      return {
        passwords: [
          "https://support.apple.com/guide/passwords/welcome/mac",
          "https://support.apple.com/guide/safari/passwords-sfri40599/mac",
        ],
        extensions: [
          "https://support.apple.com/guide/safari/use-safari-extensions-sfri32508/mac",
          "https://support.apple.com/guide/safari/customize-your-browsing-experience-sfri1e46e8e0/mac",
        ],
      };
  }
}

function browserApi(): PasswordManagerOnboardingBrowserApi | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local || !chrome.tabs?.create) {
    return null;
  }
  return {
    getLocal: (key) => chrome.storage.local.get(key),
    setLocal: (items) => chrome.storage.local.set(items),
    openTab: async (url) => {
      await chrome.tabs.create({ url });
    },
  };
}
