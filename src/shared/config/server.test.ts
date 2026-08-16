import { describe, expect, it } from "vitest";

import {
  PRODUCTION_API_URL,
  isRequiredServerOrigin,
  normalizeServerUrl,
  serverPermissionOrigin,
} from "./server";

describe("server URL configuration", () => {
  it.each([
    [" https://vault.example.com/ ", "https://vault.example.com"],
    ["https://vault.example.com/palladin/", "https://vault.example.com/palladin"],
    ["http://localhost:5000/", "http://localhost:5000"],
    ["http://127.0.0.1:5000", "http://127.0.0.1:5000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "not-a-url",
    "ftp://vault.example.com",
    "http://vault.example.com",
    "https://user:password@vault.example.com",
    "https://vault.example.com?tenant=one",
    "https://vault.example.com#fragment",
  ])("rejects unsafe server URL %s", (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });

  it("reduces a server base path to its exact permission origin", () => {
    expect(serverPermissionOrigin("https://vault.example.com/palladin"))
      .toBe("https://vault.example.com/*");
    expect(serverPermissionOrigin("invalid")).toBeNull();
  });

  it("recognises install-time Palladin origins", () => {
    expect(isRequiredServerOrigin(`${PRODUCTION_API_URL}/*`)).toBe(true);
    expect(isRequiredServerOrigin("https://vault.example.com/*")).toBe(false);
  });
});
