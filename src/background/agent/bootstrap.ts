import { connectNativeAgentProvider } from "./runtime";

export interface NativeAgentStartupEvent {
  addListener(listener: () => void): void;
}

/**
 * Start Agent Inject independently of the Vault session and register a browser-startup wake-up.
 * Public discovery cannot create trust. Pairing verification remains inside the native Agent
 * runtime and fails closed when the extension-owned pin is absent.
 */
export function startNativeAgentBridge(
  startup: NativeAgentStartupEvent = chrome.runtime.onStartup,
  connect: () => void = connectNativeAgentProvider,
): void {
  connect();
  startup.addListener(connect);
}
