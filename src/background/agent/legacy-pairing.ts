/** Remove obsolete public host pins left by extension versions before CVT-562. */

const LEGACY_PAIRING_KEYS = [
  "agentInjectHostPairing",
  "agentInjectHostPairingIntent",
] as const;

export async function clearLegacyHostPairingState(): Promise<void> {
  await chrome.storage.local.remove([...LEGACY_PAIRING_KEYS]);
}
