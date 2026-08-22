/** Value-free failure taxonomy for public Native Messaging discovery. */

export type NativePairingDiscoveryErrorCode =
  | "host-not-found"
  | "host-forbidden"
  | "host-exited"
  | "host-protocol"
  | "host-timeout"
  | "unavailable";

export class NativePairingDiscoveryError extends Error {
  constructor(readonly code: NativePairingDiscoveryErrorCode) {
    super("Native Agent pairing discovery failed");
    this.name = "NativePairingDiscoveryError";
  }
}

/**
 * Reduce Chromium's platform-specific rejection to a stable, non-sensitive code.
 * The original browser message is deliberately not propagated to the popup.
 */
export function classifyNativePairingDiscoveryError(
  cause: unknown,
): NativePairingDiscoveryError {
  if (cause instanceof NativePairingDiscoveryError) return cause;
  const message = cause instanceof Error
    ? cause.message.toLowerCase()
    : typeof cause === "string"
      ? cause.toLowerCase()
      : "";
  if (message.includes("not found") || message.includes("not registered")) {
    return new NativePairingDiscoveryError("host-not-found");
  }
  if (message.includes("forbidden") || message.includes("not allowed")) {
    return new NativePairingDiscoveryError("host-forbidden");
  }
  if (message.includes("host has exited") || message.includes("host exited")) {
    return new NativePairingDiscoveryError("host-exited");
  }
  if (message.includes("communicat") || message.includes("invalid response")) {
    return new NativePairingDiscoveryError("host-protocol");
  }
  return new NativePairingDiscoveryError("unavailable");
}
