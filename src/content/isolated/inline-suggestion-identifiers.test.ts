// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { InlineAutofillSuggestion } from "@shared/messaging";
import { ambiguousSuggestionIdentifiers } from "./inline-autofill";

const first: InlineAutofillSuggestion = {
  vaultId: "vault-one",
  entryId: "11111111-1111-4111-8111-111111aaaaaa",
  name: "example.test",
  username: "synthetic-user",
  vaultName: "Personal",
  urlDomain: "example.test",
  updatedAt: "2026-09-20T00:00:00Z",
  match: "exact",
};
const second = { ...first, entryId: "11111111-1111-4111-8111-111111bbbbbb" };

describe("ambiguous inline account suggestions", () => {
  it("distinguishes identical visible accounts with a prefix and suffix in both locales", () => {
    for (const locale of ["en", "pl"] as const) {
      expect(ambiguousSuggestionIdentifiers([first, second], locale)).toEqual(new Map([
        [first.entryId, "11111111…aaaaaa"],
        [second.entryId, "11111111…bbbbbb"],
      ]));
    }
  });

  it("does not clutter accounts already distinguished by their visible metadata", () => {
    for (const distinct of [
      { ...second, username: "different-user" },
      { ...second, name: "Work account" },
      { ...second, vaultName: "Work" },
      { ...second, match: "related" as const, urlDomain: "login.example.test" },
    ]) {
      expect(ambiguousSuggestionIdentifiers([first, distinct], "en").size).toBe(0);
    }
  });

  it("keeps identifiers for case-only variants and identically named Vaults", () => {
    const ambiguous = { ...second, username: "Synthetic-User", vaultId: "vault-two" };
    expect(ambiguousSuggestionIdentifiers([first, ambiguous], "en").size).toBe(2);
    expect(ambiguousSuggestionIdentifiers([first], "en").size).toBe(0);
  });
});
