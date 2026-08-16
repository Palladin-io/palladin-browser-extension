import { describe, expect, it } from "vitest";

import { routePortMessage } from "./router";

describe("routePortMessage", () => {
  it("answers a ping with a pong carrying the same timestamp", () => {
    expect(routePortMessage({ type: "bridge/ping", at: 123 })).toEqual({
      type: "bridge/pong",
      at: 123,
    });
  });

  it("does not answer handshake, ack, or observation traffic", () => {
    expect(routePortMessage({ type: "bridge/hello", nonce: "n" })).toBeNull();
    expect(routePortMessage({ type: "bridge/ready" })).toBeNull();
    expect(routePortMessage({ type: "bridge/pong", at: 1 })).toBeNull();
    expect(routePortMessage({ type: "webauthn/observed", kind: "get" })).toBeNull();
  });
});
