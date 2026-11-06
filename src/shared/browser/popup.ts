import { extensionBuildTarget, type ExtensionBuildTarget } from '@shared/config/build-target';

interface PopupApi {
  readonly action?: { openPopup?: (options: { windowId: number }) => Promise<void> };
}
interface PopupHost {
  readonly chrome?: PopupApi;
  readonly browser?: PopupApi;
}

export async function openCapturePopup(
  windowId: number,
  target: ExtensionBuildTarget = extensionBuildTarget,
  host: PopupHost = globalThis as typeof globalThis & PopupHost,
): Promise<boolean> {
  const api = target === 'firefox' ? host.browser?.action ?? host.chrome?.action : host.chrome?.action;
  if (!api?.openPopup) return false;
  try {
    // Preserve the browser's user-gesture context: no preceding asynchronous work.
    await api.openPopup({ windowId });
    return true;
  } catch {
    return false;
  }
}
