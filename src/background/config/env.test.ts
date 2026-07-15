import { describe, expect, it } from "vitest";

import { API_URL_PLACEHOLDERS, resolveEnv } from "./env";

describe("resolveEnv", () => {
  it("defaults to the local backend when VITE_API_URL is unset", () => {
    expect(resolveEnv({}).apiUrl).toBe("http://localhost:5000");
  });

  it("honours an override and trims a trailing slash", () => {
    expect(resolveEnv({ VITE_API_URL: "https://api.stage.palladin.io/" }).apiUrl).toBe(
      "https://api.stage.palladin.io",
    );
  });

  it("disables analytics with an empty PostHog key by default", () => {
    expect(resolveEnv({}).posthogKey).toBe("");
  });

  it("documents the not-yet-provisioned hosted environments", () => {
    expect(API_URL_PLACEHOLDERS.staging).toContain("stage");
    expect(API_URL_PLACEHOLDERS.production).toContain("palladin.io");
  });
});
