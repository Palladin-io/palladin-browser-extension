import { describe, expect, it } from "vitest";
import { parseSharedUnlockEnvironments, sharedUnlockWebMatches } from "./shared-unlock-environments";

describe("reviewed shared unlock environment pairs", () => {
  it("adds no hosted environment to a fresh clone", () => {
    expect(parseSharedUnlockEnvironments(undefined)).toEqual([]);
    expect(parseSharedUnlockEnvironments("")).toEqual([]);
  });
  it("normalizes exact HTTPS or explicit loopback pairs and freezes them", () => {
    const result = parseSharedUnlockEnvironments(JSON.stringify([
      { apiUrl: "https://api.example.test/prefix/", webOrigin: "https://app.example.test/" },
      { apiUrl: "http://localhost:5000", webOrigin: "http://127.0.0.1:5173" },
    ]));
    expect(result).toEqual([{ apiUrl: "https://api.example.test/prefix", webOrigin: "https://app.example.test" },
      { apiUrl: "http://localhost:5000", webOrigin: "http://127.0.0.1:5173" }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(sharedUnlockWebMatches(result)).toEqual(["https://app.example.test/*", "http://127.0.0.1/*"]);
  });
  for (const value of [null, {}, "bad-json", [{ apiUrl: "https://api.example.test", webOrigin: "http://app.example.test" }],
    [{ apiUrl: "http://api.example.test", webOrigin: "https://app.example.test" }],
    [{ apiUrl: "https://user:pass@api.example.test", webOrigin: "https://app.example.test" }],
    [{ apiUrl: "https://api.example.test?token=x", webOrigin: "https://app.example.test" }],
    [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test/path" }],
    [{ apiUrl: "https://api.example.test", webOrigin: "https://*.example.test" }],
    [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test", enabled: true }],
    [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test#fragment" }],
    Array.from({ length: 17 }, () => ({ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test" })),
    [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test" }, { apiUrl: "https://api2.example.test", webOrigin: "https://app.example.test" }],
    [{ apiUrl: "https://api.example.test", webOrigin: "https://app.example.test" }, { apiUrl: "https://api.example.test/", webOrigin: "https://app2.example.test" }],
  ]) {
    it(`rejects ambiguous/unsafe configuration ${JSON.stringify(value).slice(0, 80)}`, () => {
      expect(() => parseSharedUnlockEnvironments(JSON.stringify(value))).toThrow("Invalid shared unlock environment configuration");
    });
  }
});
