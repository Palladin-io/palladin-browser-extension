import { describe, expect, it, vi } from "vitest";

import { INLINE_AUTOFILL_CHANNEL } from "@shared/messaging";
import type { FillResult } from "./commands";
import type { EntryMetadata } from "./entry-metadata";
import {
  handleInlineAutofillContentMessage,
  InMemoryInlineAutofillRecency,
  type InlineAutofillDeps,
} from "./inline-runtime";

const documentId = "a".repeat(32);
const browserDocumentId = "browser-document";
const sender = {
  id: "extension-id",
  frameId: 0,
  url: "https://accounts.example.com/login",
  documentId: browserDocumentId,
  tab: { id: 7, url: "https://accounts.example.com/login" },
} as chrome.runtime.MessageSender;
const entries: EntryMetadata[] = [{
  id: "entry-1",
  vaultId: "vault-1",
  vaultName: "Personal",
  name: "Example login",
  type: 1,
  username: "ada@example.com",
  urlDomain: "accounts.example.com",
  updatedAt: "2026-08-16T00:00:00Z",
}];

function deps(overrides: Partial<InlineAutofillDeps> = {}): InlineAutofillDeps {
  return {
    getStatus: vi.fn(async () => "unlocked" as const),
    getMetadata: vi.fn(async () => entries),
    fill: vi.fn(async (): Promise<FillResult> => ({ status: "filled" })),
    ...overrides,
  };
}

describe("inline autofill content runtime", () => {
  it("returns only exact-host credential metadata while unlocked", async () => {
    expect(await handleInlineAutofillContentMessage(deps(), {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/list",
      documentId,
    }, sender, "extension-id")).toEqual({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{
        vaultId: "vault-1",
        entryId: "entry-1",
        name: "Example login",
        username: "ada@example.com",
        vaultName: "Personal",
        urlDomain: "accounts.example.com",
        updatedAt: "2026-08-16T00:00:00Z",
        match: "exact",
      }],
    });
  });

  it("returns no metadata while locked", async () => {
    const getMetadata = vi.fn(async () => entries);
    expect(await handleInlineAutofillContentMessage(deps({
      getStatus: async () => "locked",
      getMetadata,
    }), { channel: INLINE_AUTOFILL_CHANNEL, type: "inline/list", documentId }, sender, "extension-id"))
      .toEqual({ ok: true, kind: "suggestions", status: "locked", entries: [] });
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it("binds fill to the browser-authenticated sender document", async () => {
    const fill = vi.fn(async () => ({ status: "filled" }) as const);
    expect(await handleInlineAutofillContentMessage(deps({ fill }), {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/fill",
      documentId,
      vaultId: "vault-1",
      entryId: "entry-1",
      scope: "exact",
      loginTargetId: "login-1",
    }, sender, "extension-id")).toEqual({ ok: true, kind: "fill", status: "filled" });
    expect(fill).toHaveBeenCalledWith({
      id: 7,
      url: "https://accounts.example.com/login",
      documentId,
      browserDocumentId,
    }, "vault-1", "entry-1", "exact", "login-1");
  });

  it("reports a network failure as temporary unavailability, not a security block", async () => {
    expect(await handleInlineAutofillContentMessage(deps({
      fill: async (): Promise<FillResult> => ({ status: "blocked", reason: "network" }),
    }), {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/fill",
      documentId,
      vaultId: "vault-1",
      entryId: "entry-1",
      scope: "exact",
      loginTargetId: "login-1",
    }, sender, "extension-id")).toEqual({
      ok: true,
      kind: "fill",
      status: "unavailable",
    });
  });

  it("returns same-registrable-domain entries as explicit related choices", async () => {
    const sibling: EntryMetadata = {
      ...entries[0]!,
      id: "entry-related",
      urlDomain: "login.example.com",
    };
    const result = await handleInlineAutofillContentMessage(deps({
      getMetadata: async () => [...entries, sibling],
    }), {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/list",
      documentId,
    }, sender, "extension-id");
    expect(result).toMatchObject({
      ok: true,
      kind: "suggestions",
      entries: [
        { entryId: "entry-1", match: "exact" },
        { entryId: "entry-related", match: "related" },
      ],
    });
  });

  it("prefers the last successfully filled exact-host login until the session locks", async () => {
    const recency = new InMemoryInlineAutofillRecency();
    const second: EntryMetadata = {
      ...entries[0]!,
      id: "entry-2",
      name: "Second login",
      username: "grace@example.com",
    };
    const subject = deps({
      recency,
      getMetadata: async () => [entries[0]!, second],
    });

    await handleInlineAutofillContentMessage(subject, {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/fill",
      documentId,
      vaultId: "vault-1",
      entryId: "entry-2",
      scope: "exact",
      loginTargetId: "login-2",
    }, sender, "extension-id");

    const preferred = await handleInlineAutofillContentMessage(subject, {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/list",
      documentId,
    }, sender, "extension-id");
    expect(preferred).toMatchObject({
      entries: [
        { entryId: "entry-2", username: "grace@example.com" },
        { entryId: "entry-1", username: "ada@example.com" },
      ],
    });

    recency.clear();
    const cleared = await handleInlineAutofillContentMessage(subject, {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/list",
      documentId,
    }, sender, "extension-id");
    expect(cleared).toMatchObject({ entries: [{ entryId: "entry-1" }, { entryId: "entry-2" }] });
  });

  it("rejects frames and origin mismatches before reading state", async () => {
    const subject = deps();
    expect(await handleInlineAutofillContentMessage(subject, {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/list",
      documentId,
    }, { ...sender, frameId: 1 }, "extension-id")).toEqual({ ok: false, code: "unavailable" });
    expect(subject.getStatus).not.toHaveBeenCalled();
  });

  it("leaves the user-gesture surface command to the synchronous background adapter", async () => {
    const subject = deps();
    expect(await handleInlineAutofillContentMessage(subject, {
      channel: INLINE_AUTOFILL_CHANNEL,
      type: "inline/open-palladin",
      documentId,
    }, sender, "extension-id")).toBeNull();
    expect(subject.getStatus).not.toHaveBeenCalled();
  });
});
