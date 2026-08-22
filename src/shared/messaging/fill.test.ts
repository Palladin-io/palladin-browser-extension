import { describe, expect, it } from "vitest";

import {
  FILL_REQUEST_CHANNEL,
  isFillOutcome,
  isFillRequestMessage,
} from "./fill";

const request = {
  channel: FILL_REQUEST_CHANNEL,
  documentId: "page-load-document-1",
  expectedOrigin: "https://accounts.example.com",
  expectedDomain: "example.com",
  submit: false,
  capabilityId: null,
  fields: [{ kind: "password", value: "secret" }],
} as const;

describe("fill message guards", () => {
  it("accepts a request bound to the prepared document, origin, and domain", () => {
    expect(isFillRequestMessage(request)).toBe(true);
  });

  it("rejects unbound or non-canonical fill targets", () => {
    expect(isFillRequestMessage({ ...request, documentId: "" })).toBe(false);
    expect(isFillRequestMessage({ ...request, expectedOrigin: "http://accounts.example.com" })).toBe(false);
    expect(isFillRequestMessage({ ...request, expectedOrigin: "https://accounts.example.com/login" })).toBe(false);
    expect(isFillRequestMessage({ ...request, capabilityId: "bad" })).toBe(false);
    const { submit: _submit, ...withoutSubmit } = request;
    expect(isFillRequestMessage(withoutSubmit)).toBe(false);
    expect(isFillRequestMessage({ ...request, unexpected: true })).toBe(false);
  });

  it("accepts submit only for a credential request containing a password", () => {
    expect(isFillRequestMessage({ ...request, submit: true })).toBe(true);
    expect(isFillRequestMessage({
      ...request,
      submit: true,
      fields: [{ kind: "username", value: "ada" }],
    })).toBe(false);
    expect(isFillRequestMessage({
      ...request,
      submit: true,
      fields: [{ kind: "password", value: "secret" }, { kind: "card-number", value: "4111" }],
    })).toBe(false);
  });

  it("accepts the fail-closed target-changed outcome", () => {
    expect(isFillOutcome({ ok: false, reason: "target-changed" })).toBe(true);
  });
});
