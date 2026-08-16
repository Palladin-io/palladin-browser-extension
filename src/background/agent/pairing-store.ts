/**
 * Durable storage boundary for the non-secret native-host identity pin.
 *
 * The explicit popup ceremony verifies an out-of-band CLI bundle before calling
 * the writer. Session keys, ephemeral keys, nonces, and channel material must
 * never enter this module.
 */

const PAIRING_KEY = "agentInjectHostPairing";

export interface HostPairingRecord {
  readonly hostSigningPublicKey: string;
  readonly fingerprint: string;
}

export async function loadHostPairingRecord(): Promise<unknown> {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  return stored[PAIRING_KEY];
}

export async function saveHostPairingRecord(record: HostPairingRecord): Promise<void> {
  await chrome.storage.local.set({
    [PAIRING_KEY]: {
      hostSigningPublicKey: record.hostSigningPublicKey,
      fingerprint: record.fingerprint,
    },
  });
}

export async function clearHostPairingRecord(): Promise<void> {
  await chrome.storage.local.remove(PAIRING_KEY);
}
