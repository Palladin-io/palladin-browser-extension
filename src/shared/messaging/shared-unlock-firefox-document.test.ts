import { describe, expect, it } from "vitest";
import { FIREFOX_DOCUMENT_BINDING, isFirefoxDocumentBinding } from "./shared-unlock-firefox-document";
const valid = { type: FIREFOX_DOCUMENT_BINDING, marker: "aaaabbbb-1234-4567-8abc-111111111111" };
describe("private Firefox document binding", () => {
  it("accepts the bounded own-frame document marker", () => expect(isFirefoxDocumentBinding(valid)).toBe(true));
  it.each([null, [], {}, { ...valid, marker: null }, { ...valid, marker: "page-marker" },
    { ...valid, type: "hello" }, { ...valid, token: "synthetic" }, { type: valid.type },
    Object.assign(Object.create(valid) as object, { other: true, extra: true })])("rejects foreign framing %#", value => {
      expect(isFirefoxDocumentBinding(value)).toBe(false);
    });
});
