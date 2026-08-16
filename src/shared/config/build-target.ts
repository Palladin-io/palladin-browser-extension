export type ExtensionBuildTarget = "chromium" | "firefox" | "safari";

/** Only Chromium currently has the reviewed 30-second offscreen wipe path. */
export function supportsTimedClipboardWipe(target: ExtensionBuildTarget): boolean {
  return target === "chromium";
}

export const extensionBuildTarget: ExtensionBuildTarget = __PALLADIN_TARGET__;
export const clipboardCopyAvailable = supportsTimedClipboardWipe(extensionBuildTarget);
