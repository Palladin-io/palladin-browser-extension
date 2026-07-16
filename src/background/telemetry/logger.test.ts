import { describe, expect, it, vi } from "vitest";

import { createLogger, redactMeta, REDACTED, type LogValue } from "./logger";

describe("redactMeta", () => {
  it("redacts values under sensitive-looking keys", () => {
    const out = redactMeta({
      password: "hunter2",
      masterKey: "AAAA",
      accessToken: "jwt",
      authHash: "argon",
      recoveryCode: "abc",
      mnemonic: "word word",
      nonce: "n",
    });
    for (const key of Object.keys(out)) {
      expect(out[key]).toBe(REDACTED);
    }
  });

  it("keeps non-sensitive metadata intact", () => {
    expect(redactMeta({ status: "unlocked", count: 3, ok: true })).toEqual({
      status: "unlocked",
      count: 3,
      ok: true,
    });
  });
});

describe("createLogger", () => {
  it("never forwards a sensitive value to the sink", () => {
    const sink = vi.fn<(level: string, line: string, meta?: Record<string, LogValue>) => void>();
    const logger = createLogger(sink);

    logger.info("login attempt", { email: "a@b.co", password: "secret", status: "ok" });

    expect(sink).toHaveBeenCalledTimes(1);
    const meta = sink.mock.calls[0][2]!;
    expect(meta["password"]).toBe(REDACTED);
    expect(meta["email"]).toBe("a@b.co");
    expect(meta["status"]).toBe("ok");
    // The raw secret never reaches the sink in any field.
    expect(JSON.stringify(meta)).not.toContain("secret");
  });

  it("passes a plain message through with no meta", () => {
    const sink = vi.fn();
    createLogger(sink).warn("session init failed");
    expect(sink).toHaveBeenCalledWith("warn", "session init failed", undefined);
  });
});
