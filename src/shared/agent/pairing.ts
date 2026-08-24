/** Strict public pairing and discovery shapes shared by the popup and service worker. */

export const AGENT_PAIRING_PROTOCOL = "palladin.inject-pairing.v1" as const;

const MAX_PAIRING_BUNDLE_LENGTH = 2_048;
// A 32-byte value has 42 complete base64url characters plus four data bits in
// the final character. Its two unused low bits must be zero.
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface AgentPairingBundle {
  readonly protocol: typeof AGENT_PAIRING_PROTOCOL;
  /** Canonical unpadded base64url Ed25519 public key. Never a secret. */
  readonly hostSigningPublicKey: string;
  /** SHA-256 fingerprint produced by the shared Palladin crypto package. */
  readonly fingerprint: string;
}

export interface AgentPairingOffer extends AgentPairingBundle {
  readonly type: "pairing.offer";
  readonly extensionOrigin: string;
  readonly challenge: string;
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
  return parseAgentPairingBundleValue(parsed);
}

export function parseAgentPairingBundleValue(value: unknown): AgentPairingBundle | null {
  if (!isRecord(value) || !onlyKeys(value, [
    "protocol",
    "hostSigningPublicKey",
    "fingerprint",
  ])) return null;
  if (value.protocol !== AGENT_PAIRING_PROTOCOL
    || !isCanonicalBase64Url32(value.hostSigningPublicKey)
    || !isCanonicalBase64Url32(value.fingerprint)) return null;
  return value as unknown as AgentPairingBundle;
}

/** Parse one challenge-bound, public offer returned by the allowlisted native host. */
export function parseAgentPairingOffer(
  value: unknown,
  expectedExtensionOrigin: string,
  expectedChallenge: string,
): AgentPairingBundle | null {
  if (!isRecord(value) || !onlyKeys(value, [
    "protocol",
    "type",
    "extensionOrigin",
    "challenge",
    "hostSigningPublicKey",
    "fingerprint",
  ])) return null;
  if (value.protocol !== AGENT_PAIRING_PROTOCOL
    || value.type !== "pairing.offer"
    || value.extensionOrigin !== expectedExtensionOrigin
    || value.challenge !== expectedChallenge
    || !isCanonicalBase64Url32(value.hostSigningPublicKey)
    || !isCanonicalBase64Url32(value.fingerprint)) return null;
  return {
    protocol: AGENT_PAIRING_PROTOCOL,
    hostSigningPublicKey: value.hostSigningPublicKey,
    fingerprint: value.fingerprint,
  };
}

/** Public identifiers are always displayed with both a prefix and suffix. */
export function shortenPublicIdentifier(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function isCanonicalBase64Url32(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_32.test(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
