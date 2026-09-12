import { describe, expect, it } from "vitest";
import { installFirefoxDocumentMarker } from "./firefox-document-marker";

describe("isolated Firefox top document lifetime", () => {
  it("invalidates on pagehide and gives a restored document a fresh marker", () => {
    const owner = new EventTarget(), isolated: { __palladinFirefoxDocumentV1?: { marker: string | null } } = {};
    let generation = 0;
    installFirefoxDocumentMarker(owner as Window, isolated, () => `generation-${++generation}`);
    expect(isolated.__palladinFirefoxDocumentV1?.marker).toBe("generation-1");
    installFirefoxDocumentMarker(owner as Window, isolated, () => "must-not-replace");
    owner.dispatchEvent(new Event("pagehide")); expect(isolated.__palladinFirefoxDocumentV1?.marker).toBeNull();
    const restored = Object.assign(new Event("pageshow"), { persisted: true }); owner.dispatchEvent(restored);
    expect(isolated.__palladinFirefoxDocumentV1?.marker).toBe("generation-2");
  });
});
