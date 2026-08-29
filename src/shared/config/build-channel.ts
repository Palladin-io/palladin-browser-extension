export const EXTENSION_BUILD_CHANNELS = ["production", "debug"] as const;

export type ExtensionBuildChannel = (typeof EXTENSION_BUILD_CHANNELS)[number];

export function resolveExtensionBuildChannel(
  value: string | undefined,
  fallback: ExtensionBuildChannel = "production",
): ExtensionBuildChannel {
  const channel = value ?? fallback;
  if (EXTENSION_BUILD_CHANNELS.some((candidate) => candidate === channel)) {
    return channel as ExtensionBuildChannel;
  }
  throw new Error(
    `Unknown extension build channel: ${channel}. Expected one of: ${EXTENSION_BUILD_CHANNELS.join(", ")}`,
  );
}

export function nativeHostNameForChannel(channel: ExtensionBuildChannel): string {
  return channel === "debug" ? "io.palladin.debug" : "io.palladin";
}
