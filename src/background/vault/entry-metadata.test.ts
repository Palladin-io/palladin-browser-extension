import { describe, expect, it } from "vitest";

import {
  ENTRY_TYPE_CREDENTIAL,
  entriesForTab,
  searchEntries,
  type EntryMetadata,
} from "./entry-metadata";

function meta(over: Partial<EntryMetadata> & Pick<EntryMetadata, "id" | "name">): EntryMetadata {
  return {
    vaultId: "v1",
    type: ENTRY_TYPE_CREDENTIAL,
    updatedAt: "2026-07-15T00:00:00Z",
    ...over,
  };
}

describe("entriesForTab", () => {
  const entries = [
    meta({ id: "a", name: "Example", urlDomain: "www.example.com" }),
    meta({ id: "b", name: "Other", urlDomain: "other.org" }),
    meta({ id: "c", name: "No domain" }),
  ];

  it("keeps only entries whose registered domain matches the tab", () => {
    const result = entriesForTab(entries, "https://www.example.com/login");
    expect(result.map((e) => e.id)).toEqual(["a"]);
  });

  it("returns nothing without a tab url", () => {
    expect(entriesForTab(entries, null)).toEqual([]);
  });
});

describe("searchEntries", () => {
  const entries = [
    meta({ id: "a", name: "GitHub", urlDomain: "github.com" }),
    meta({ id: "b", name: "GitLab", urlDomain: "gitlab.com" }),
    meta({ id: "c", name: "Bank", urlDomain: "mybank.example" }),
  ];

  it("matches on name (case-insensitive)", () => {
    expect(searchEntries(entries, "git").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("matches on domain", () => {
    expect(searchEntries(entries, "mybank").map((e) => e.id)).toEqual(["c"]);
  });

  it("returns everything sorted by name for an empty query", () => {
    expect(searchEntries(entries, "  ").map((e) => e.name)).toEqual(["Bank", "GitHub", "GitLab"]);
  });
});
