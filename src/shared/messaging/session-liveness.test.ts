import { describe, expect, it } from "vitest";

import {
  isSessionLivenessControl,
  isSessionLivenessPing,
  SESSION_LIVENESS_CHANNEL,
  sessionLivenessControl,
} from "./session-liveness";

describe("session liveness wire", () => {
  it("accepts only the exact value-free control shape", () => {
    expect(isSessionLivenessControl(sessionLivenessControl(true))).toBe(true);
    expect(isSessionLivenessControl({
      channel: SESSION_LIVENESS_CHANNEL,
      type: "control",
      enabled: true,
      userId: "not-allowed",
    })).toBe(false);
  });

  it("accepts only an exact value-free ping", () => {
    expect(isSessionLivenessPing({
      channel: SESSION_LIVENESS_CHANNEL,
      type: "ping",
    })).toBe(true);
    expect(isSessionLivenessPing({
      channel: SESSION_LIVENESS_CHANNEL,
      type: "ping",
      at: 123,
    })).toBe(false);
  });
});
