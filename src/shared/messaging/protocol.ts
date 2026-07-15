/**
 * Typed protocol for the 3-layer content bridge:
 *
 *   page main world  <-- window.postMessage -->  isolated world  <-- chrome Port -->  service worker
 *
 * Two transports, one message vocabulary:
 *  - Between main and isolated worlds we wrap every {@link BridgeMessage} in a
 *    {@link WindowEnvelope} carrying the channel tag, direction, and a per-page
 *    session nonce. The main world shares its JS context with the page, so the
 *    envelope fields are defense-in-depth (origin + source + nonce + direction),
 *    NOT a trust anchor — a hostile page script can observe the nonce. The real
 *    trust boundary is the service worker, which never performs a
 *    security-sensitive action on the strength of a page-originated message
 *    alone (fills are gated by grant/user choice, never by page content).
 *  - Between the isolated world and the service worker we send the bare
 *    {@link BridgeMessage} over a {@link chrome.runtime.Port}; that channel is
 *    already isolated from the page.
 *
 * Everything here is a stub vocabulary. Real fill / passkey messages arrive with
 * the fill engine and the WebAuthn interceptor (CVT-362) — the shape below is the
 * slot they plug into.
 */

export const BRIDGE_CHANNEL = "palladin.bridge.v1" as const;

/** Direction of a window envelope, named relative to the isolated content script. */
export type BridgeDirection = "isolated->main" | "main->isolated";

/**
 * The semantic messages carried across the bridge. Discriminated on `type`.
 * Extend this union — do not widen a payload to `unknown` — so every transport
 * stays exhaustively type-checked.
 */
export type BridgeMessage =
  | { readonly type: "bridge/hello"; readonly nonce: string }
  | { readonly type: "bridge/ready" }
  | { readonly type: "bridge/ping"; readonly at: number }
  | { readonly type: "bridge/pong"; readonly at: number }
  | { readonly type: "webauthn/observed"; readonly kind: "get" | "create" }
  // User-activity heartbeat: resets the idle auto-lock timer in the worker
  // (see background/session). Carries no data — it is a bare signal, and it is
  // never a trust anchor for a fill (fills are gated separately).
  | { readonly type: "session/activity" };

export type BridgeMessageType = BridgeMessage["type"];

const BRIDGE_MESSAGE_TYPES: ReadonlySet<string> = new Set<BridgeMessageType>([
  "bridge/hello",
  "bridge/ready",
  "bridge/ping",
  "bridge/pong",
  "webauthn/observed",
  "session/activity",
]);

/** Envelope wrapping a {@link BridgeMessage} for the window.postMessage transport. */
export interface WindowEnvelope {
  readonly channel: typeof BRIDGE_CHANNEL;
  readonly direction: BridgeDirection;
  readonly nonce: string;
  readonly payload: BridgeMessage;
}

export function isBridgeMessageType(value: unknown): value is BridgeMessageType {
  return typeof value === "string" && BRIDGE_MESSAGE_TYPES.has(value);
}

/**
 * Structural guard for a {@link BridgeMessage}. Validates the discriminant and
 * the fields each variant requires; rejects anything else. Kept exhaustive so a
 * new variant that forgets its guard branch fails the `never` check at compile
 * time.
 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown };
  if (!isBridgeMessageType(candidate.type)) return false;

  const message = value as BridgeMessage;
  switch (message.type) {
    case "bridge/hello":
      return typeof message.nonce === "string" && message.nonce.length > 0;
    case "bridge/ready":
      return true;
    case "bridge/ping":
    case "bridge/pong":
      return typeof message.at === "number" && Number.isFinite(message.at);
    case "webauthn/observed":
      return message.kind === "get" || message.kind === "create";
    case "session/activity":
      return true;
    default: {
      const _exhaustive: never = message;
      return _exhaustive;
    }
  }
}

export function isWindowEnvelope(value: unknown): value is WindowEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WindowEnvelope>;
  return (
    candidate.channel === BRIDGE_CHANNEL &&
    (candidate.direction === "isolated->main" ||
      candidate.direction === "main->isolated") &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length > 0 &&
    isBridgeMessage(candidate.payload)
  );
}

export function createEnvelope(
  direction: BridgeDirection,
  nonce: string,
  payload: BridgeMessage,
): WindowEnvelope {
  return { channel: BRIDGE_CHANNEL, direction, nonce, payload };
}
