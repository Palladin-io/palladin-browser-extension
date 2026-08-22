/** Public native-host discovery. This module never creates or persists trust. */

import { injectHostKeyFingerprint } from "@palladin/crypto";
import {
  AGENT_PAIRING_PROTOCOL,
  parseAgentPairingOffer,
  type AgentPairingBundle,
} from "@shared/agent/pairing";

import { NATIVE_HOST_NAME } from "./native-provider";

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Ask the exact allowlisted Native Messaging host for its public identity.
 *
 * The challenge prevents a stale response from being accepted. The derived fingerprint proves
 * internal consistency, but the offer remains untrusted until the user compares it with the
 * trusted CLI output and confirms it in the popup.
 */
export async function discoverNativeAgentPairingOffer(): Promise<AgentPairingBundle> {
  const extensionOrigin = chrome.runtime.getURL("");
  const challenge = crypto.randomUUID();
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  try {
    const raw = await receivePairingOffer(port, {
      protocol: AGENT_PAIRING_PROTOCOL,
      type: "pairing.discover",
      extensionOrigin,
      challenge,
    });
    const offer = parseAgentPairingOffer(raw, extensionOrigin, challenge);
    if (offer === null) throw new Error("Invalid native-host pairing offer");
    const derivedFingerprint = await injectHostKeyFingerprint(offer.hostSigningPublicKey);
    if (derivedFingerprint !== offer.fingerprint) {
      throw new Error("Native-host pairing fingerprint mismatch");
    }
    return offer;
  } finally {
    try {
      port.disconnect();
    } catch {
      // The one-shot discovery port may already have closed after its response.
    }
  }
}

function receivePairingOffer(
  port: chrome.runtime.Port,
  request: Readonly<Record<string, string>>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => finishReject(), DISCOVERY_TIMEOUT_MS);
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    const finishReject = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Native-host pairing discovery unavailable"));
    };
    const onMessage = (raw: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(raw);
    };
    const onDisconnect = () => {
      void chrome.runtime.lastError;
      finishReject();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage(request);
    } catch {
      finishReject();
    }
  });
}
