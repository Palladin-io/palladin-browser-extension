export const ONBOARDING_PAGE_PATH = "src/onboarding/index.html";

export interface OnboardingTabApi {
  getUrl(path: string): string;
  openTab(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
}

export function shouldOpenOnboarding(details: chrome.runtime.InstalledDetails): boolean {
  return details.reason === "install";
}

export async function openOnboardingAfterInstall(
  details: chrome.runtime.InstalledDetails,
  api: OnboardingTabApi = browserApi(),
): Promise<void> {
  if (!shouldOpenOnboarding(details)) return;
  await api.openTab({ url: api.getUrl(ONBOARDING_PAGE_PATH), active: true });
}

function browserApi(): OnboardingTabApi {
  return {
    getUrl: (path) => chrome.runtime.getURL(path),
    openTab: (options) => chrome.tabs.create(options),
  };
}
