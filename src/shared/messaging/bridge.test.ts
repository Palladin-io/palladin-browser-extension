import { describe, expect, it } from "vitest";

import {
  generateNonce,
  type InboundContext,
  type InboundMessage,
  validateInboundEnvelope,
} from "./bridge";
import { createEnvelope } from "./protocol";

const SELF = { name: "this-frame" };
const ORIGIN = "https://app.example.com";
const NONCE = "session-nonce-abc";

function ctx(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    self: SELF,
    expectedOrigin: ORIGIN,
    expectedDirection: "main->isolated",
    expectedNonce: NONCE,
    ...overrides,
  };
}

function event(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: SELF,
    origin: ORIGIN,
    data: createEnvelope("main->isolated", NONCE, { type: "bridge/ready" }),
    ...overrides,
  };
}

describe("validateInboundEnvelope", () => {
  it("accepts a well-formed, correctly-attributed message", () => {
    const result = validateInboundEnvelope(event(), ctx());
    expect(result).toEqual({ ok: true, message: { type: "bridge/ready" } });
  });

  it("rejects a message from another window (source spoofing / cross-frame)", () => {
    const result = validateInboundEnvelope(
      event({ source: { name: "other-frame" } }),
      ctx(),
    );
    expect(result).toEqual({ ok: false, reason: "source-mismatch" });
  });

  it("rejects a message from a different origin (cross-origin iframe)", () => {
    const result = validateInboundEnvelope(
      event({ origin: "https://evil.example.com" }),
      ctx(),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("ignores foreign (non-bridge) postMessage traffic", () => {
    expect(validateInboundEnvelope(event({ data: "hello" }), ctx())).toEqual({
      ok: false,
      reason: "not-bridge",
    });
    expect(validateInboundEnvelope(event({ data: null }), ctx())).toEqual({
      ok: false,
      reason: "not-bridge",
    });
    expect(
      validateInboundEnvelope(event({ data: { channel: "other" } }), ctx()),
    ).toEqual({ ok: false, reason: "not-bridge" });
  });

  it("rejects a message travelling in the wrong direction (reflection)", () => {
    const reflected = createEnvelope("isolated->main", NONCE, {
      type: "bridge/ready",
    });
    expect(
      validateInboundEnvelope(event({ data: reflected }), ctx()),
    ).toEqual({ ok: false, reason: "direction-mismatch" });
  });

  it("rejects a message with a missing or wrong nonce (forgery / replay)", () => {
    const noNonce = { ...createEnvelope("main->isolated", NONCE, { type: "bridge/ready" }), nonce: "" };
    expect(validateInboundEnvelope(event({ data: noNonce }), ctx())).toEqual({
      ok: false,
      reason: "nonce-mismatch",
    });

    const wrongNonce = createEnvelope("main->isolated", "not-the-nonce", {
      type: "bridge/ready",
    });
    expect(
      validateInboundEnvelope(event({ data: wrongNonce }), ctx()),
    ).toEqual({ ok: false, reason: "nonce-mismatch" });
  });

  it("rejects an envelope wrapping an unknown payload", () => {
    const badPayload = {
      ...createEnvelope("main->isolated", NONCE, { type: "bridge/ready" }),
      payload: { type: "evil/exfiltrate" },
    };
    expect(
      validateInboundEnvelope(event({ data: badPayload }), ctx()),
    ).toEqual({ ok: false, reason: "bad-payload" });
  });

  it("accepts the bootstrap handshake before a nonce is pinned (expectedNonce null)", () => {
    const hello = createEnvelope("isolated->main", NONCE, {
      type: "bridge/hello",
      nonce: NONCE,
    });
    const result = validateInboundEnvelope(
      event({ data: hello }),
      ctx({ expectedDirection: "isolated->main", expectedNonce: null }),
    );
    expect(result).toEqual({
      ok: true,
      message: { type: "bridge/hello", nonce: NONCE },
    });
  });

  it("still requires a non-empty nonce even during the handshake", () => {
    const hello = {
      ...createEnvelope("isolated->main", NONCE, { type: "bridge/hello", nonce: NONCE }),
      nonce: "",
    };
    expect(
      validateInboundEnvelope(
        event({ data: hello }),
        ctx({ expectedDirection: "isolated->main", expectedNonce: null }),
      ),
    ).toEqual({ ok: false, reason: "nonce-mismatch" });
  });
});

describe("generateNonce", () => {
  it("produces a 32-char hex string (128 bits)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses the injected crypto source", () => {
    const fixed = new Uint8Array(16).fill(0xab);
    const nonce = generateNonce({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.set(fixed);
        return array;
      },
    });
    expect(nonce).toBe("ab".repeat(16));
  });

  it("returns distinct values across calls", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
