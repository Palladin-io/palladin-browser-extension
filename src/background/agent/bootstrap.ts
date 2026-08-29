import { extensionBuildTarget } from "@shared/config/build-target";

import { connectNativeAgentProvider } from "./runtime";
import { clearLegacyHostPairingState } from "./legacy-pairing";

export interface NativeAgentStartupEvent {
  addListener(listener: () => void): void;
}

/**
 * Start Agent Inject independently of the Vault session and register a browser-startup wake-up.
 * Browser/platform Native Messaging authorization is the provider identity boundary; no Vault,
 * account, profile, or extension-owned pairing state participates in this connection.
 */
export function startNativeAgentBridge(
  startup: NativeAgentStartupEvent = chrome.runtime.onStartup,
  connect: () => void = connectNativeAgentProvider,
  clearLegacyPairing: () => Promise<void> = clearLegacyHostPairingState,
  bridgeSupported: boolean = extensionBuildTarget === "chromium",
): void {
  void clearLegacyPairing().catch(() => undefined);
  if (!bridgeSupported) return;
  connect();
  startup.addListener(connect);
}
