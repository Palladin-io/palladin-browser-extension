import { describe, expect, it } from "vitest";
import { isLegacyFillToDocument, isLegacyFillToWorker } from "./firefox-legacy-fill";
import { FILL_REQUEST_CHANNEL } from "./fill";

const requestId = "12345678-1234-1234-1234-123456789abc";
function fill() { return { type: "fill", requestId, issuedAt: 1000,
  request: { channel: FILL_REQUEST_CHANNEL, documentId: "a".repeat(32), expectedOrigin: "https://example.test",
    expectedDomain: "example.test", submit: false, loginTargetId: null, fields: [{ kind: "password", value: "synthetic" }] } }; }
describe("private Firefox fill protocol boundary", () => {
  it("accepts only isolated nonce hello and value-free correlated results", () => {
    expect(isLegacyFillToWorker({ type: "hello", documentId: "a".repeat(32) })).toBe(true);
    expect(isLegacyFillToWorker({ type: "result", requestId, outcome: { ok: true } })).toBe(true);
    expect(isLegacyFillToWorker({ type: "result", requestId, outcome: { ok: false, reason: "target-changed" } })).toBe(true);
    for (const invalid of [null, [], { type: "hello", documentId: "native-id" },
      { type: "hello", documentId: "a".repeat(32), origin: "https://example.test" },
      { type: "result", requestId, outcome: { ok: true, password: "synthetic" } },
      { type: "result", requestId, outcome: { ok: false, reason: "anything" } }, fill()]) {
      expect(isLegacyFillToWorker(invalid)).toBe(false);
    }
  });
  it("rejects invalid secret envelopes before the DOM consumer", () => {
    expect(isLegacyFillToDocument(fill())).toBe(true);
    const insecure = fill(); insecure.request.expectedOrigin = "http://example.test";
    const fields = fill(); fields.request.fields[0].kind = "unknown";
    for (const invalid of [null, [], { type: "ready", request: fill().request },
      { ...fill(), issuedAt: NaN }, { ...fill(), issuedAt: -1 }, { ...fill(), issuedAt: 1.5 },
      { ...fill(), requestId: "short" }, { ...fill(), extra: true }, insecure, fields,
      { type: "hello", documentId: "a".repeat(32) }]) expect(isLegacyFillToDocument(invalid)).toBe(false);
  });
});
