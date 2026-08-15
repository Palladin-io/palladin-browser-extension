import { describe, expect, it } from "vitest";

import { matchesAgentInjectionTarget } from "./domain";

describe("Agent Inject target matching", () => {
  it("accepts the authenticated host and its descendants", () => {
    expect(matchesAgentInjectionTarget(
      "https://login.example.com/start",
      "login.example.com",
    )).toBe(true);
    expect(matchesAgentInjectionTarget(
      "https://accounts.login.example.com/start",
      "login.example.com",
    )).toBe(true);
  });

  it("rejects siblings, suffix tricks, IPs, localhost, and public/private suffixes", () => {
    expect(matchesAgentInjectionTarget(
      "https://evil.example.com",
      "login.example.com",
    )).toBe(false);
    expect(matchesAgentInjectionTarget(
      "https://login.example.com.evil.test",
      "login.example.com",
    )).toBe(false);
    expect(matchesAgentInjectionTarget("https://127.0.0.1", "127.0.0.1")).toBe(false);
    expect(matchesAgentInjectionTarget("https://localhost", "localhost")).toBe(false);
    expect(matchesAgentInjectionTarget("https://alice.github.io", "github.io")).toBe(false);
  });
});
