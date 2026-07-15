import { describe, expect, it, vi } from "vitest";

import type { FillField, FillOutcome } from "@shared/messaging";

import { FakeStorageArea } from "../session/test-support";
import {
  dispatchVaultCommand,
  isVaultCommand,
  type ActiveTab,
  type VaultCommandDeps,
} from "./commands";
import { VaultClient } from "./vault-client";
import { VaultDataService } from "./vault-data-service";
import { VaultStore } from "./vault-store";
import { buildVaultWorld, fakeSession, vaultBackend, type VaultWorld } from "./test-support";

const API = "http://api.test";
const HTTPS_MATCH = "https://example.com/login";

interface Harness {
  deps: VaultCommandDeps;
  sendFill: ReturnType<typeof vi.fn>;
  arm: ReturnType<typeof vi.fn>;
}

async function makeHarness(
  world: VaultWorld,
  tab: ActiveTab | null,
  fillOutcome: FillOutcome = { ok: true },
): Promise<Harness> {
  const client = new VaultClient(vaultBackend(world, { validToken: "valid-token" }).fetch, API);
  const service = new VaultDataService({
    client,
    store: new VaultStore(new FakeStorageArea()),
    session: fakeSession(world),
  });
  await service.refresh();

  const sendFill = vi.fn(
    (_tabId: number, _fields: readonly FillField[]): Promise<FillOutcome> =>
      Promise.resolve(fillOutcome),
  );
  const arm = vi.fn();
  const deps: VaultCommandDeps = {
    data: service,
    getActiveTab: () => Promise.resolve(tab),
    sendFill,
    clipboard: { arm },
    now: () => 0,
  };
  return { deps, sendFill, arm };
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
    const [, fields] = sendFill.mock.calls[0];
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
    world.vaults[0].entries[1].urlDomain = "www.example.com";
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
});

describe("vault/reveal + vault/totp", () => {
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
    expect(isVaultCommand({ type: "vault/reveal", vaultId: "v", entryId: "e", field: "password" })).toBe(true);
    expect(isVaultCommand({ type: "vault/reveal", vaultId: "v", entryId: "e", field: "bogus" })).toBe(false);
    expect(isVaultCommand({ type: "vault/fill", vaultId: "v" })).toBe(false);
    expect(isVaultCommand({ type: "session/status" })).toBe(false);
    expect(isVaultCommand(null)).toBe(false);
  });
});
