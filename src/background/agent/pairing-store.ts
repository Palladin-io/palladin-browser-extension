/**
 * Durable storage boundary for the non-secret native-host identity pin.
 *
 * No writer exists until an independently verified, explicit pairing ceremony
 * is implemented. Session keys, ephemeral keys, nonces, and channel material
 * must never enter this module.
 */

const PAIRING_KEY = "agentInjectHostPairing";

export async function loadHostPairingRecord(): Promise<unknown> {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  return stored[PAIRING_KEY];
}
