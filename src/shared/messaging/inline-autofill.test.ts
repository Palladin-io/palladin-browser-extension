import { describe, expect, it } from "vitest";

import {
  INLINE_AUTOFILL_CHANNEL,
  isInlineAutofillCommand,
  isInlineAutofillResult,
} from "./inline-autofill";

const documentId = "a".repeat(32);
const capabilityId = "b".repeat(32);

describe("inline autofill messages", () => {
  it("accepts exact list, fill, and open commands only", () => {
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/list", documentId })).toBe(true);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/fill", documentId, vaultId: "v", entryId: "e", capabilityId, submit: false, scope: "exact" })).toBe(true);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/open-palladin", documentId })).toBe(true);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/list", documentId, extra: true })).toBe(false);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/fill", documentId: "bad", vaultId: "v", entryId: "e", capabilityId, submit: false, scope: "exact" })).toBe(false);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/fill", documentId, vaultId: "v", entryId: "e", capabilityId, submit: false, scope: "site-wide" })).toBe(false);
    expect(isInlineAutofillCommand({ channel: INLINE_AUTOFILL_CHANNEL, type: "inline/fill", documentId, vaultId: "v", entryId: "e", capabilityId: "bad", submit: false, scope: "exact" })).toBe(false);
  });

  it("accepts value-free strict responses", () => {
    expect(isInlineAutofillResult({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{ vaultId: "v", entryId: "e", name: "Example", username: "ada@example.com", vaultName: "Personal", urlDomain: "example.com", match: "exact" }],
    })).toBe(true);
    expect(isInlineAutofillResult({ ok: true, kind: "fill", status: "filled" })).toBe(true);
    expect(isInlineAutofillResult({ ok: true, kind: "surface", status: "opened" })).toBe(true);
    expect(isInlineAutofillResult({ ok: true, kind: "fill", status: "filled", value: "secret" })).toBe(false);
  });
});
