import { describe, expect, it } from "vitest";

import {
  TAB_URL_REQUEST_CHANNEL,
  isTabUrlRequestMessage,
  isTabUrlResponse,
} from "./tab-url";

describe("public tab URL messaging", () => {
  it("accepts only the exact request and bounded response shapes", () => {
    expect(isTabUrlRequestMessage({ channel: TAB_URL_REQUEST_CHANNEL })).toBe(true);
    expect(isTabUrlRequestMessage({ channel: TAB_URL_REQUEST_CHANNEL, extra: true })).toBe(false);
    const documentId = "a".repeat(32);
    expect(isTabUrlResponse({ url: "https://example.com/login", documentId })).toBe(true);
    expect(isTabUrlResponse({ url: "https://example.com", documentId, extra: true })).toBe(false);
    expect(isTabUrlResponse({ url: "", documentId })).toBe(false);
    expect(isTabUrlResponse({ url: "x".repeat(8_193), documentId })).toBe(false);
    expect(isTabUrlResponse({ url: "https://example.com", documentId: "not-a-nonce" })).toBe(false);
  });
});
