import { describe, expect, it } from "vitest";

import {
  BRIDGE_CHANNEL,
  createEnvelope,
  isBridgeMessage,
  isBridgeMessageType,
  isWindowEnvelope,
} from "./protocol";

describe("isBridgeMessageType", () => {
  it("accepts known discriminants", () => {
    expect(isBridgeMessageType("bridge/hello")).toBe(true);
    expect(isBridgeMessageType("webauthn/observed")).toBe(true);
  });

  it("rejects unknown or non-string values", () => {
    expect(isBridgeMessageType("bridge/unknown")).toBe(false);
    expect(isBridgeMessageType(42)).toBe(false);
    expect(isBridgeMessageType(null)).toBe(false);
  });
});

describe("isBridgeMessage", () => {
  it("accepts each well-formed variant", () => {
    expect(isBridgeMessage({ type: "bridge/hello", nonce: "abc" })).toBe(true);
    expect(isBridgeMessage({ type: "bridge/ready" })).toBe(true);
    expect(isBridgeMessage({ type: "bridge/ping", at: 1 })).toBe(true);
    expect(isBridgeMessage({ type: "bridge/pong", at: 2 })).toBe(true);
    expect(isBridgeMessage({ type: "webauthn/observed", kind: "get" })).toBe(true);
    expect(isBridgeMessage({ type: "session/activity" })).toBe(true);
  });

  it("rejects malformed variants", () => {
    expect(isBridgeMessage({ type: "bridge/hello" })).toBe(false); // missing nonce
    expect(isBridgeMessage({ type: "bridge/hello", nonce: "" })).toBe(false); // empty nonce
    expect(isBridgeMessage({ type: "bridge/ping", at: "soon" })).toBe(false); // wrong type
    expect(isBridgeMessage({ type: "bridge/ping", at: Number.NaN })).toBe(false);
    expect(isBridgeMessage({ type: "webauthn/observed", kind: "sign" })).toBe(false);
  });

  it("rejects non-objects and unknown types", () => {
    expect(isBridgeMessage(null)).toBe(false);
    expect(isBridgeMessage("bridge/ready")).toBe(false);
    expect(isBridgeMessage({ type: "evil" })).toBe(false);
  });
});

describe("createEnvelope / isWindowEnvelope", () => {
  it("round-trips a valid envelope", () => {
    const envelope = createEnvelope("isolated->main", "nonce-1", {
      type: "bridge/ready",
    });
    expect(envelope.channel).toBe(BRIDGE_CHANNEL);
    expect(isWindowEnvelope(envelope)).toBe(true);
  });

  it("rejects envelopes with the wrong channel, direction, nonce, or payload", () => {
    const base = createEnvelope("main->isolated", "n", { type: "bridge/ready" });
    expect(isWindowEnvelope({ ...base, channel: "other" })).toBe(false);
    expect(isWindowEnvelope({ ...base, direction: "sideways" })).toBe(false);
    expect(isWindowEnvelope({ ...base, nonce: "" })).toBe(false);
    expect(isWindowEnvelope({ ...base, payload: { type: "evil" } })).toBe(false);
  });
});
