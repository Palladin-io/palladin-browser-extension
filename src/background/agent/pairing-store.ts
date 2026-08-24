/**
 * Durable storage boundary for the non-secret native-host identity pin.
 *
 * The explicit popup ceremony compares an automatically discovered public
 * identity with the independent CLI fingerprint before calling the writer.
 * Session keys, ephemeral keys, nonces, and channel material must never enter
 * this module.
 */

const PAIRING_KEY = "agentInjectHostPairing";
const PAIRING_INTENT_KEY = "agentInjectHostPairingIntent";

export type HostPairingIntentToken = string;

export interface HostPairingRecord {
  readonly hostSigningPublicKey: string;
  readonly fingerprint: string;
  readonly intentToken: HostPairingIntentToken;
}

export interface HostPairingSnapshot {
  readonly record: unknown;
  readonly intentToken: unknown;
}

export async function loadHostPairingSnapshot(): Promise<HostPairingSnapshot> {
  const stored = await chrome.storage.local.get([PAIRING_KEY, PAIRING_INTENT_KEY]);
  return {
    record: stored[PAIRING_KEY],
    intentToken: stored[PAIRING_INTENT_KEY],
  };
}

export async function saveHostPairingIntent(
  intentToken: HostPairingIntentToken,
): Promise<void> {
  await chrome.storage.local.set({ [PAIRING_INTENT_KEY]: intentToken });
}

export async function saveHostPairingRecord(record: HostPairingRecord): Promise<void> {
  await chrome.storage.local.set({
    [PAIRING_KEY]: {
      hostSigningPublicKey: record.hostSigningPublicKey,
      fingerprint: record.fingerprint,
      intentToken: record.intentToken,
    },
  });
}

export async function clearHostPairingRecord(): Promise<void> {
  await chrome.storage.local.remove(PAIRING_KEY);
}

export function isHostPairingIntentToken(value: unknown): value is HostPairingIntentToken {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
