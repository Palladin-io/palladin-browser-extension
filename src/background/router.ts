/**
 * Pure routing for messages arriving at the service worker over the content
 * Port. Kept side-effect-free and testable: given a message, return the reply to
 * post back (or `null` for fire-and-forget). Real routing (grant-gated fill
 * dispatch) plugs in here behind the same contract.
 */

import type { BridgeMessage } from "@shared/messaging";

export function routePortMessage(message: BridgeMessage): BridgeMessage | null {
  switch (message.type) {
    case "bridge/ping":
      return { type: "bridge/pong", at: message.at };
    case "bridge/hello":
    case "bridge/ready":
    case "bridge/pong":
      // Handshake / ack traffic — nothing to answer.
      return null;
    case "webauthn/observed":
      // Slot for the passkey interceptor (CVT-362). No-op until that strategy
      // exists; recorded here without any credential data.
      return null;
    default: {
      const _exhaustive: never = message;
      return _exhaustive;
    }
  }
}
