/**
 * Validation + helpers for the window.postMessage leg of the bridge (main world
 * <-> isolated world). The isolated world is the enforcement point: it accepts a
 * main-world message only when it can attribute it to this frame's own window and
 * this page load's session nonce, and rejects everything else. See
 * {@link ./protocol.ts} for why these fields are defense-in-depth rather than a
 * trust anchor.
 */

import {
  BRIDGE_CHANNEL,
  type BridgeDirection,
  type BridgeMessage,
  isBridgeMessage,
  type WindowEnvelope,
} from "./protocol";

export type RejectionReason =
  | "source-mismatch"
  | "origin-mismatch"
  | "not-bridge"
  | "direction-mismatch"
  | "nonce-mismatch"
  | "bad-payload";

export type ValidationResult =
  | { readonly ok: true; readonly message: BridgeMessage }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * A minimal, testable view of a `MessageEvent`. The real content scripts pass a
 * DOM `MessageEvent`; tests pass a plain object with the same three fields.
 */
export interface InboundMessage {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface InboundContext {
  /** The window we require `event.source` to equal — this frame, not another. */
  readonly self: unknown;
  /** The origin we require `event.origin` to equal — this frame's own origin. */
  readonly expectedOrigin: string;
  /** The direction a valid inbound envelope must declare. */
  readonly expectedDirection: BridgeDirection;
  /**
   * The session nonce a valid envelope must carry, or `null` before the
   * handshake has established one (the main world accepts the first
   * `bridge/hello` without a prior nonce, then pins it).
   */
  readonly expectedNonce: string | null;
}

/**
 * Validate an inbound window message against the bridge contract. Returns the
 * unwrapped {@link BridgeMessage} on success, or a precise rejection reason.
 * `source-mismatch` / `origin-mismatch` / `not-bridge` are ordinary foreign
 * traffic the caller should ignore silently; `direction-mismatch` /
 * `nonce-mismatch` / `bad-payload` are anomalies worth counting (value-free).
 */
export function validateInboundEnvelope(
  event: InboundMessage,
  ctx: InboundContext,
): ValidationResult {
  if (event.source !== ctx.self) {
    return { ok: false, reason: "source-mismatch" };
  }
  if (event.origin !== ctx.expectedOrigin) {
    return { ok: false, reason: "origin-mismatch" };
  }

  const data = event.data;
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "not-bridge" };
  }

  const envelope = data as Partial<WindowEnvelope>;
  if (envelope.channel !== BRIDGE_CHANNEL) {
    return { ok: false, reason: "not-bridge" };
  }
  if (envelope.direction !== ctx.expectedDirection) {
    return { ok: false, reason: "direction-mismatch" };
  }
  if (typeof envelope.nonce !== "string" || envelope.nonce.length === 0) {
    return { ok: false, reason: "nonce-mismatch" };
  }
  if (ctx.expectedNonce !== null && envelope.nonce !== ctx.expectedNonce) {
    return { ok: false, reason: "nonce-mismatch" };
  }
  if (!isBridgeMessage(envelope.payload)) {
    return { ok: false, reason: "bad-payload" };
  }

  return { ok: true, message: envelope.payload };
}

/** Generate a per-page-load session nonce (128 bits, hex-encoded). */
export function generateNonce(
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
