/** Strict out-of-band pairing bundle shared by the popup and service worker. */

export const AGENT_PAIRING_PROTOCOL = "palladin.inject-pairing.v1" as const;

const MAX_PAIRING_BUNDLE_LENGTH = 2_048;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export interface AgentPairingBundle {
  readonly protocol: typeof AGENT_PAIRING_PROTOCOL;
  /** Canonical unpadded base64url Ed25519 public key. Never a secret. */
  readonly hostSigningPublicKey: string;
  /** SHA-256 fingerprint produced by the shared Palladin crypto package. */
  readonly fingerprint: string;
}

export type AgentPairingStatus =
  | { readonly paired: false }
  | { readonly paired: true; readonly fingerprint: string };

/**
 * Parse only the single-line JSON bundle printed through the trusted runtime CLI.
 * Whitespace surrounding the JSON is tolerated for terminal copy/paste; unknown
 * fields and non-canonical encodings fail closed.
 */
export function parseAgentPairingBundle(value: string): AgentPairingBundle | null {
  if (value.length < 1 || value.length > MAX_PAIRING_BUNDLE_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !onlyKeys(parsed, [
    "protocol",
    "hostSigningPublicKey",
    "fingerprint",
  ])) return null;
  if (parsed.protocol !== AGENT_PAIRING_PROTOCOL
    || typeof parsed.hostSigningPublicKey !== "string"
    || !BASE64URL_32.test(parsed.hostSigningPublicKey)
    || typeof parsed.fingerprint !== "string"
    || !BASE64URL_32.test(parsed.fingerprint)) return null;
  return parsed as unknown as AgentPairingBundle;
}

/** Public identifiers are always displayed with both a prefix and suffix. */
export function shortenPublicIdentifier(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
