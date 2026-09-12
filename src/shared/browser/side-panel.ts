import {
  extensionBuildTarget,
  type ExtensionBuildTarget,
} from "@shared/config/build-target";

interface ChromiumSidePanelApi {
  readonly windows?: {
    readonly WINDOW_ID_CURRENT: number;
  };
  readonly sidePanel?: {
    open(options: { readonly windowId: number }): Promise<void>;
  };
}

interface FirefoxSidebarApi {
  readonly sidebarAction?: {
    open(): Promise<void>;
  };
}

export interface SidePanelHost {
  readonly chrome?: ChromiumSidePanelApi;
  readonly browser?: FirefoxSidebarApi;
}

/** A shared build target does not guarantee that the browser implements its panel API. */
export function supportsSidePanel(
  target: ExtensionBuildTarget,
  host: SidePanelHost = defaultHost(),
): boolean {
  if (target === "chromium") {
    return Boolean(host.chrome?.windows) && typeof host.chrome?.sidePanel?.open === "function";
  }
  return target === "firefox" && typeof host.browser?.sidebarAction?.open === "function";
}

function defaultHost(): SidePanelHost {
  return globalThis as typeof globalThis & SidePanelHost;
}

/**
 * Open the browser-owned full Vault surface after an explicit user gesture.
 * This adapter moves no Vault data and creates no storage path; both panels use
 * the same extension-origin React app and worker command channel.
 */
export async function openSidePanel(
  target: ExtensionBuildTarget = extensionBuildTarget,
  host: SidePanelHost = defaultHost(),
  windowId?: number,
): Promise<boolean> {
  if (target === "chromium") {
    const windows = host.chrome?.windows;
    const sidePanel = host.chrome?.sidePanel;
    if (!windows || !sidePanel) return false;
    // Do not await another API first: both Chrome and Firefox require this call
    // to remain in the direct user-gesture handler.
    await sidePanel.open({ windowId: windowId ?? windows.WINDOW_ID_CURRENT });
    return true;
  }

  if (target === "firefox") {
    const sidebarAction = host.browser?.sidebarAction;
    if (!sidebarAction) return false;
    await sidebarAction.open();
    return true;
  }

  return false;
}
