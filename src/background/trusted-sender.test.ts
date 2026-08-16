import { describe, expect, it } from "vitest";

import { isTrustedExtensionPage } from "./trusted-sender";

const ID = "extension-id";
const ORIGIN = `chrome-extension://${ID}/`;

describe("isTrustedExtensionPage", () => {
  it("accepts an extension-owned popup", () => {
    expect(isTrustedExtensionPage({ id: ID, url: `${ORIGIN}popup.html` }, ID, ORIGIN)).toBe(true);
  });

  it("rejects content scripts, foreign extensions, and forged URLs", () => {
    expect(isTrustedExtensionPage({ id: ID, url: "https://example.com", tab: {} }, ID, ORIGIN)).toBe(false);
    expect(isTrustedExtensionPage({ id: "foreign", url: `${ORIGIN}popup.html` }, ID, ORIGIN)).toBe(false);
    expect(isTrustedExtensionPage({ id: ID, url: `chrome-extension://${ID}.evil/popup` }, ID, ORIGIN)).toBe(false);
  });
});
