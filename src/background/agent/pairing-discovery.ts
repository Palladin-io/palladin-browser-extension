/** Public native-host discovery. This module never creates or persists trust. */

import { injectHostKeyFingerprint } from "@palladin/crypto";
import {
  AGENT_PAIRING_PROTOCOL,
  parseAgentPairingOffer,
  type AgentPairingBundle,
} from "@shared/agent/pairing";

import { NATIVE_HOST_NAME } from "./native-provider";
import {
  classifyNativePairingDiscoveryError,
  NativePairingDiscoveryError,
} from "./pairing-errors";

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
  const raw = await receivePairingOffer({
    protocol: AGENT_PAIRING_PROTOCOL,
    type: "pairing.discover",
    extensionOrigin,
    challenge,
  });
  const offer = parseAgentPairingOffer(raw, extensionOrigin, challenge);
  if (offer === null) throw new NativePairingDiscoveryError("host-protocol");
  const derivedFingerprint = await injectHostKeyFingerprint(offer.hostSigningPublicKey);
  if (derivedFingerprint !== offer.fingerprint) {
    throw new NativePairingDiscoveryError("host-protocol");
  }
  return offer;
}

function receivePairingOffer(
  request: Readonly<Record<string, string>>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(
      () => finishReject(new NativePairingDiscoveryError("host-timeout")),
      DISCOVERY_TIMEOUT_MS,
    );
    const finishReject = (cause: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(classifyNativePairingDiscoveryError(cause));
    };
    const finishResolve = (raw: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(raw);
    };
    try {
      void chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request)
        .then(finishResolve, finishReject);
    } catch (cause) {
      finishReject(cause);
    }
  });
}
