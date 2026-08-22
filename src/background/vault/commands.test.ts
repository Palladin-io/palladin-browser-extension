import { describe, expect, it, vi } from "vitest";
import type { MemberSecretV1 } from "@palladin/crypto";

import type { FillField, FillOutcome } from "@shared/messaging";

import {
  dispatchVaultCommand,
  fillInlineSelectedEntry,
  isVaultCommand,
  type ActiveTab,
  type VaultCommandDeps,
} from "./commands";
import type { EntryMetadata } from "./entry-metadata";

const HTTPS_MATCH = "https://example.com/login";

interface Harness {
  deps: VaultCommandDeps;
  sendFill: ReturnType<typeof vi.fn>;
  openLoginTab: ReturnType<typeof vi.fn>;
  arm: ReturnType<typeof vi.fn>;
  revealEntry: ReturnType<typeof vi.fn>;
}

type TestTab = Omit<ActiveTab, "documentId" | "browserDocumentId"> & {
  readonly documentId?: string;
  readonly browserDocumentId?: string;
};

interface CommandWorld {
  readonly metadata: EntryMetadata[];
  readonly secrets: Map<string, MemberSecretV1>;
}

const COMMON_SECRET = {
  schema: "palladin.member-secret.v1",
  agentLabel: null,
  discoverable: false,
  description: null,
  icon: null,
  color: null,
  agentFieldAccess: {},
} as const;

function buildVaultWorld(): CommandWorld {
  const credential: MemberSecretV1 = {
    ...COMMON_SECRET,
    entryType: "credential",
    memberLabel: "Example login",
    content: {
      username: "ada@example.com",
      password: "s3cr3t-p@ss",
      url: "https://example.com/login",
      urlDomain: "example.com",
      totp: {
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        issuer: "Palladin",
        account: "me",
      },
      notes: null,
      customFields: [],
    },
  };
  const key: MemberSecretV1 = {
    ...COMMON_SECRET,
    entryType: "key",
    memberLabel: "API key",
    content: { value: "sk-key-value-xyz", notes: null, customFields: [] },
  };
  return {
    metadata: [
      {
        id: "entry-cred",
        vaultId: "vault-1",
        vaultName: "Personal",
        name: "Example login",
        type: 1,
        urlDomain: "example.com",
        updatedAt: "2026-07-15T00:00:00Z",
      },
      {
        id: "entry-key",
        vaultId: "vault-1",
        vaultName: "Personal",
        name: "API key",
        type: 0,
        updatedAt: "2026-07-15T00:00:00Z",
      },
    ],
    secrets: new Map<string, MemberSecretV1>([
      ["entry-cred", credential],
      ["entry-key", key],
    ]),
  };
}

async function makeHarness(
  world: CommandWorld,
  tab: TestTab | null,
  fillOutcome: FillOutcome = { ok: true },
): Promise<Harness> {
  const sendFill = vi.fn(
    (_target: ActiveTab, _expectedDomain: string | null, _fields: readonly FillField[]): Promise<FillOutcome> =>
      Promise.resolve(fillOutcome),
  );
  const arm = vi.fn();
  const resolvedTab = tab === null
    ? null
    : {
        ...tab,
        documentId: tab.documentId ?? "document-1",
        browserDocumentId: tab.browserDocumentId ?? "browser-document-1",
      };
  const openLoginTab = vi.fn(async () => resolvedTab);
  const revealEntry = vi.fn(async (_vaultId: string, entryId: string) => {
    const secret = world.secrets.get(entryId);
    if (secret === undefined) throw new Error("missing fixture");
    return secret;
  });
  const deps: VaultCommandDeps = {
    data: {
      refresh: async () => world.metadata,
      refreshIfStale: async () => world.metadata,
      clearCache: async () => undefined,
      getMetadata: async () => world.metadata,
      revealEntry,
    },
    getActiveTab: () => Promise.resolve(resolvedTab),
    openLoginTab,
    sendFill,
    clipboard: { available: true, arm },
    now: () => 0,
  };
  return { deps, sendFill, openLoginTab, arm, revealEntry };
}

describe("vault/list", () => {
  it("returns for-site matches and the full corpus with the site info", async () => {
    const world = await buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, { type: "vault/list" });
    if (!("list" in result) || !result.ok) throw new Error("expected a list");

    expect(result.list.site).toEqual({ domain: "example.com", secure: true });
    expect(result.list.forSite.map((e) => e.id)).toEqual(["entry-cred"]);
    expect(result.list.all.map((e) => e.id).sort()).toEqual(["entry-cred", "entry-key"]);
  });

  it("uses the freshness-aware refresh path for a UI sync", async () => {
    const world = await buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });
    const refresh = vi.spyOn(deps.data, "refresh");
    const refreshIfStale = vi.spyOn(deps.data, "refreshIfStale");

    const result = await dispatchVaultCommand(deps, { type: "vault/sync" });

    expect(result.ok).toBe(true);
    expect(refreshIfStale).toHaveBeenCalledWith(15 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("vault/fill gates", () => {
  it("fills a credential when the tab matches over https", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, { id: 7, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    expect(result).toEqual({ ok: true, fill: { status: "filled" } });
    // Username + password handed over — password last.
    const [target, expectedDomain, fields] = sendFill.mock.calls[0];
    expect(target).toEqual({
      id: 7,
      url: HTTPS_MATCH,
      documentId: "document-1",
      browserDocumentId: "browser-document-1",
    });
    expect(expectedDomain).toBe("example.com");
    expect(fields).toEqual([
      { kind: "username", value: "ada@example.com" },
      { kind: "password", value: "s3cr3t-p@ss" },
    ]);
  });

  it("blocks on a domain mismatch and never decrypts", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, { id: 1, url: "https://evil.com/login" });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    expect(result).toEqual({ ok: true, fill: { status: "blocked", reason: "domain-mismatch" } });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("allows a one-shot related-host inline choice and keeps the final DOM gate exact", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, {
      id: 7,
      url: "https://accounts.example.com/login",
    });

    expect(await fillInlineSelectedEntry(
      deps,
      {
        id: 7,
        url: "https://accounts.example.com/login",
        documentId: "document-1",
        browserDocumentId: "browser-document-1",
      },
      "vault-1",
      "entry-cred",
      "related",
      "login-1",
    )).toEqual({ status: "filled" });
    expect(sendFill).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://accounts.example.com/login" }),
      "accounts.example.com",
      expect.any(Array),
      false,
      "login-1",
    );
  });

  it("never lets related-host consent cross a registrable-domain boundary", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill, revealEntry } = await makeHarness(world, {
      id: 7,
      url: "https://evil.test/login",
    });

    expect(await fillInlineSelectedEntry(
      deps,
      {
        id: 7,
        url: "https://evil.test/login",
        documentId: "document-1",
        browserDocumentId: "browser-document-1",
      },
      "vault-1",
      "entry-cred",
      "related",
      "login-1",
    )).toEqual({ status: "blocked", reason: "domain-mismatch" });
    expect(revealEntry).not.toHaveBeenCalled();
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("blocks when latest decrypt moved the credential off the cached host", async () => {
    const world = await buildVaultWorld();
    const current = world.secrets.get("entry-cred");
    if (!current || current.entryType !== "credential") throw new Error("expected credential");
    world.secrets.set("entry-cred", {
      ...current,
      content: {
        ...current.content,
        url: "https://login.other.test",
        urlDomain: "login.other.test",
      },
    });
    const { deps, sendFill } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    expect(await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "blocked", reason: "domain-mismatch" } });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("blocks a non-https page", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, { id: 1, url: "http://example.com/login" });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    expect(result).toEqual({ ok: true, fill: { status: "blocked", reason: "insecure-page" } });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("blocks a non-credential entry", async () => {
    const world = await buildVaultWorld();
    // Give the KEY entry a matching domain so only the type gate can block it.
    world.metadata[1] = { ...world.metadata[1]!, urlDomain: "example.com" };
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-key",
    });
    expect(result).toEqual({ ok: true, fill: { status: "blocked", reason: "not-fillable" } });
  });

  it("surfaces no-form when the page has no login form", async () => {
    const world = await buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH }, {
      ok: false,
      reason: "no-form",
    });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    expect(result).toEqual({ ok: true, fill: { status: "no-form" } });
  });

  it("fails closed when the prepared credential document changes before the DOM write", async () => {
    const world = buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH }, {
      ok: false,
      reason: "target-changed",
    });

    expect(await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "blocked", reason: "target-changed" } });
  });

  it("blocks with no active tab", async () => {
    const world = await buildVaultWorld();
    const { deps } = await makeHarness(world, null);

    const result = await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    expect(result).toEqual({ ok: true, fill: { status: "blocked", reason: "no-active-tab" } });
  });

  it("fills the current exact login form without opening a duplicate tab", async () => {
    const world = buildVaultWorld();
    const { deps, openLoginTab, sendFill } = await makeHarness(world, {
      id: 12,
      url: "https://example.com/sign-in",
      documentId: "login-document",
      browserDocumentId: "browser-login-document",
    });

    expect(await dispatchVaultCommand(deps, {
      type: "vault/login",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "filled" } });
    expect(openLoginTab).not.toHaveBeenCalled();
    expect(sendFill).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, documentId: "login-document" }),
      "example.com",
      [
        { kind: "username", value: "ada@example.com" },
        { kind: "password", value: "s3cr3t-p@ss" },
      ],
      true,
    );
  });

  it("opens the credential host when the current page does not match", async () => {
    const world = buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, {
      id: 7,
      url: "https://unrelated.test/",
    });
    const opened = {
      id: 12,
      url: "https://example.com/sign-in",
      documentId: "login-document",
      browserDocumentId: "browser-login-document",
    };
    const openLoginTab = vi.fn(async () => opened);
    deps.openLoginTab = openLoginTab;

    expect(await dispatchVaultCommand(deps, {
      type: "vault/login",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "filled" } });
    expect(openLoginTab).toHaveBeenCalledWith("https://example.com/");
    expect(sendFill).toHaveBeenCalledWith(
      opened,
      "example.com",
      expect.any(Array),
      true,
    );
  });

  it("opens the credential host when the current exact page has no login form", async () => {
    const world = buildVaultWorld();
    const { deps, sendFill, openLoginTab } = await makeHarness(world, {
      id: 12,
      url: "https://example.com/account",
    });
    sendFill
      .mockResolvedValueOnce({ ok: false, reason: "no-form" })
      .mockResolvedValueOnce({ ok: true });

    expect(await dispatchVaultCommand(deps, {
      type: "vault/login",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "filled" } });
    expect(openLoginTab).toHaveBeenCalledWith("https://example.com/");
    expect(sendFill).toHaveBeenCalledTimes(2);
  });

  it("does not decrypt when login navigation lands on another host", async () => {
    const world = buildVaultWorld();
    const { deps, revealEntry, sendFill } = await makeHarness(world, null);
    deps.openLoginTab = vi.fn(async () => ({
      id: 12,
      url: "https://evil.example.net/",
      documentId: "evil-document",
      browserDocumentId: "browser-evil-document",
    }));

    expect(await dispatchVaultCommand(deps, {
      type: "vault/login",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, fill: { status: "blocked", reason: "domain-mismatch" } });
    expect(revealEntry).not.toHaveBeenCalled();
    expect(sendFill).not.toHaveBeenCalled();
  });
});

describe("credit card commands", () => {
  it("binds an explicitly selected card fill to the exact live HTTPS host", async () => {
    const sendFill = vi.fn(async (): Promise<FillOutcome> => ({ ok: true }));
    const deps: VaultCommandDeps = {
      data: {
        refresh: async () => [],
        refreshIfStale: async () => [],
        clearCache: async () => undefined,
        getMetadata: async () => [{
          id: "card-1",
          vaultId: "vault-1",
          vaultName: "Personal",
          name: "Personal card",
          type: 3,
          updatedAt: "2026-08-16T12:00:00Z",
        }],
        revealEntry: async () => ({
          schema: "palladin.member-secret.v1",
          entryType: "creditCard",
          memberLabel: "Personal card",
          agentLabel: null,
          discoverable: false,
          description: null,
          icon: null,
          color: null,
          agentFieldAccess: {},
          content: {
            cardholderName: "Ada Lovelace",
            cardNumber: "4111111111111111",
            expiryMonth: "08",
            expiryYear: "2030",
            billingAddress: "12 Computing Lane",
            notes: null,
            customFields: [],
          },
        }),
      },
      getActiveTab: async () => ({
        id: 7,
        url: "https://checkout.shop.test/pay",
        documentId: "checkout-document",
        browserDocumentId: "browser-checkout-document",
      }),
      openLoginTab: async () => null,
      sendFill,
      clipboard: { available: true, arm: vi.fn() },
    };

    expect(await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "card-1",
    })).toEqual({ ok: true, fill: { status: "filled" } });
    expect(sendFill).toHaveBeenCalledWith({
      id: 7,
      url: "https://checkout.shop.test/pay",
      documentId: "checkout-document",
      browserDocumentId: "browser-checkout-document",
    }, "checkout.shop.test", [
      { kind: "cardholder", value: "Ada Lovelace" },
      { kind: "card-number", value: "4111111111111111" },
      { kind: "card-expiry-month", value: "08" },
      { kind: "card-expiry-year", value: "2030" },
      { kind: "card-expiry", value: "08/30" },
      { kind: "billing-address", value: "12 Computing Lane" },
    ], false);
  });

  it("fails closed when the prepared card document changes before the DOM write", async () => {
    const world = buildVaultWorld();
    world.metadata.push({
      id: "card-1",
      vaultId: "vault-1",
      vaultName: "Personal",
      name: "Card",
      type: 3,
      updatedAt: "2026-08-16T12:00:00Z",
    });
    const card = {
      ...COMMON_SECRET,
      entryType: "creditCard",
      memberLabel: "Card",
      content: {
        cardholderName: "Ada",
        cardNumber: "4111111111111111",
        expiryMonth: "08",
        expiryYear: "2030",
        billingAddress: null,
        notes: null,
        customFields: [],
      },
    } as const satisfies MemberSecretV1;
    world.secrets.set("card-1", card);
    const { deps } = await makeHarness(world, {
      id: 7,
      url: "https://checkout.shop.test/pay",
    }, { ok: false, reason: "target-changed" });

    expect(await dispatchVaultCommand(deps, {
      type: "vault/fill",
      vaultId: "vault-1",
      entryId: "card-1",
    })).toEqual({ ok: true, fill: { status: "blocked", reason: "target-changed" } });
  });

  it("accepts only the reviewed card save fields", () => {
    const card = {
      label: "Personal card",
      cardholderName: "Ada Lovelace",
      cardNumber: "4111 1111 1111 1111",
      expiryMonth: "08",
      expiryYear: "2030",
      billingAddress: "12 Computing Lane",
      notes: "Primary",
    };
    expect(isVaultCommand({ type: "vault/entry-save", entry: { entryType: "creditCard", ...card } })).toBe(true);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: {
        entryType: "creditCard",
        ...card,
        customFields: [{ id: "custom:neutral_code", label: "CVV", type: "concealed", value: "123" }],
      },
    })).toBe(true);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: { entryType: "creditCard", ...card, verificationCode: "123" },
    })).toBe(false);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: { entryType: "creditCard", ...card, pin: "1234" },
    })).toBe(false);
  });
});

describe("generated secret actions", () => {
  it("fills only the password field on a secure active page", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, { id: 7, url: HTTPS_MATCH });
    const result = await dispatchVaultCommand(deps, { type: "vault/fill-generated", value: "new-secret" });
    expect(result).toEqual({ ok: true, fill: { status: "filled" } });
    expect(sendFill).toHaveBeenCalledWith(
      {
        id: 7,
        url: HTTPS_MATCH,
        documentId: "document-1",
        browserDocumentId: "browser-document-1",
      },
      null,
      [{ kind: "generated", value: "new-secret" }],
      false,
    );
  });

  it("fails closed when the prepared generated-fill document changes", async () => {
    const world = buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 7, url: HTTPS_MATCH }, {
      ok: false,
      reason: "target-changed",
    });
    expect(await dispatchVaultCommand(deps, {
      type: "vault/fill-generated",
      value: "new-secret",
    })).toEqual({ ok: true, fill: { status: "blocked", reason: "target-changed" } });
  });

  it("blocks generated fill on an insecure page", async () => {
    const world = await buildVaultWorld();
    const { deps, sendFill } = await makeHarness(world, { id: 7, url: "http://example.com" });
    const result = await dispatchVaultCommand(deps, { type: "vault/fill-generated", value: "new-secret" });
    expect(result).toEqual({ ok: true, fill: { status: "blocked", reason: "insecure-page" } });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("arms clipboard clearing without receiving the generated value", async () => {
    const world = await buildVaultWorld();
    const { deps, arm } = await makeHarness(world, null);
    expect(await dispatchVaultCommand(deps, { type: "vault/clipboard-arm" })).toEqual({ ok: true, clipboardArmed: true });
    expect(arm).toHaveBeenCalledOnce();
  });
});

describe("vault/reveal + vault/totp", () => {
  it("rejects reveal and clipboard arming before decryption when timed wipe is unavailable", async () => {
    const world = buildVaultWorld();
    const { deps, revealEntry, arm } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });
    deps.clipboard = { available: false, arm };

    expect(await dispatchVaultCommand(deps, {
      type: "vault/reveal",
      vaultId: "vault-1",
      entryId: "entry-cred",
      field: "password",
    })).toEqual({
      ok: false,
      code: "bad-request",
      message: "Copy is unavailable on this browser",
    });
    expect(await dispatchVaultCommand(deps, { type: "vault/clipboard-arm" })).toEqual({
      ok: false,
      code: "bad-request",
      message: "Clipboard wipe is unavailable",
    });
    expect(revealEntry).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
  });

  it("reveals a field and arms the clipboard wipe", async () => {
    const world = await buildVaultWorld();
    const { deps, arm } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/reveal",
      vaultId: "vault-1",
      entryId: "entry-cred",
      field: "password",
    });
    expect(result).toEqual({ ok: true, reveal: { value: "s3cr3t-p@ss" } });
    expect(arm).toHaveBeenCalledOnce();
  });

  it("reveals a username for an explicitly expanded extension group without touching clipboard", async () => {
    const world = await buildVaultWorld();
    const { deps, arm } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });
    deps.clipboard = { available: false, arm };

    expect(await dispatchVaultCommand(deps, {
      type: "vault/credential-username",
      vaultId: "vault-1",
      entryId: "entry-cred",
    })).toEqual({ ok: true, credentialUsername: { value: "ada@example.com" } });
    expect(arm).not.toHaveBeenCalled();
  });

  it("computes a TOTP code on demand without arming the clipboard", async () => {
    const world = await buildVaultWorld();
    const { deps, arm } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/totp",
      vaultId: "vault-1",
      entryId: "entry-cred",
    });
    if (!("totp" in result) || !result.ok) throw new Error("expected a totp view");
    expect(result.totp).not.toBeNull();
    expect(result.totp?.code).toMatch(/^\d{6}$/);
    expect(result.totp?.period).toBe(30);
    expect(arm).not.toHaveBeenCalled();
  });

  it("returns null totp for an entry without a seed", async () => {
    const world = await buildVaultWorld();
    const { deps } = await makeHarness(world, { id: 1, url: HTTPS_MATCH });

    const result = await dispatchVaultCommand(deps, {
      type: "vault/totp",
      vaultId: "vault-1",
      entryId: "entry-key",
    });
    expect(result).toEqual({ ok: true, totp: null });
  });
});

describe("isVaultCommand", () => {
  it("accepts well-formed commands and rejects malformed ones", () => {
    expect(isVaultCommand({ type: "vault/list" })).toBe(true);
    expect(isVaultCommand({ type: "vault/fill", vaultId: "v", entryId: "e" })).toBe(true);
    expect(isVaultCommand({ type: "vault/login", vaultId: "v", entryId: "e" })).toBe(true);
    expect(isVaultCommand({ type: "vault/reveal", vaultId: "v", entryId: "e", field: "password" })).toBe(true);
    expect(isVaultCommand({ type: "vault/credential-username", vaultId: "v", entryId: "e" })).toBe(true);
    expect(isVaultCommand({ type: "vault/reveal", vaultId: "v", entryId: "e", field: "bogus" })).toBe(false);
    expect(isVaultCommand({ type: "vault/fill", vaultId: "v" })).toBe(false);
    expect(isVaultCommand({ type: "vault/fill-generated", value: "secret" })).toBe(true);
    expect(isVaultCommand({ type: "vault/fill-generated", value: "" })).toBe(false);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: { entryType: "key", label: "API key", value: "secret" },
    })).toBe(true);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: { entryType: "key", label: "API key", value: "secret", extra: true },
    })).toBe(false);
    expect(isVaultCommand({
      type: "vault/entry-save",
      entry: { entryType: "script", label: "Script", source: "echo ok", interpreter: "powershell" },
    })).toBe(false);
    expect(isVaultCommand({ type: "vault/clipboard-arm" })).toBe(true);
    expect(isVaultCommand({ type: "session/status" })).toBe(false);
    expect(isVaultCommand(null)).toBe(false);
  });
});
