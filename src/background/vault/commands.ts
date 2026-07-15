/**
 * Typed command channel between the popup and the service worker for vault data
 * — the list/search view, on-demand reveal (copy), on-demand TOTP, and the
 * gated fill. It is a SEPARATE surface from the session commands (same transport,
 * different vocabulary) so the two stay independently testable.
 *
 * SECURITY: every action that touches a secret is gated HERE, in the worker,
 * never in the popup or the page:
 *   - reveal/totp require an unlocked session (the data service enforces it) and
 *     return a value the popup uses transiently; the worker arms a clipboard wipe
 *     when the value was copied.
 *   - fill re-resolves the active tab and re-checks the eTLD+1 match and HTTPS at
 *     the moment of the click (not just when the list was rendered), decrypts,
 *     and only then hands ready values to the tab's content script.
 *
 * Everything Chrome-adjacent (active tab, fill transport, clipboard arm) is
 * injected so `dispatchVaultCommand` is a pure async function over fakes.
 */

import {
  ENTRY_TYPE_CREDENTIAL,
  ENTRY_TYPE_KEY,
  generateTotp,
  parseOtpauthUri,
  type EntryPlaintext,
  type TotpParams,
} from "@palladin/crypto";

import type { FillField, FillOutcome } from "@shared/messaging";

import { isSecurePage, matchesTab, registrableDomain } from "./domain";
import { entriesForTab, searchEntries, type EntryMetadata } from "./entry-metadata";
import {
  VaultDataError,
  type VaultDataErrorCode,
  type VaultDataService,
} from "./vault-data-service";

// ─── Command + result vocabulary ──────────────────────────────────────────────

/** Which decrypted field a reveal returns (for copy). */
export type VaultRevealField = "username" | "password" | "value" | "totp";

export type VaultCommand =
  | { readonly type: "vault/list" }
  | { readonly type: "vault/sync" }
  | {
      readonly type: "vault/reveal";
      readonly vaultId: string;
      readonly entryId: string;
      readonly field: VaultRevealField;
    }
  | { readonly type: "vault/totp"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/fill"; readonly vaultId: string; readonly entryId: string };

export type VaultCommandType = VaultCommand["type"];

/** The active tab reduced to what the gate/display need. */
export interface SiteInfo {
  /** eTLD+1 of the active tab, or null when there is no matchable domain. */
  readonly domain: string | null;
  /** True only on an HTTPS page — fill is blocked otherwise. */
  readonly secure: boolean;
}

export interface VaultListView {
  readonly site: SiteInfo;
  /** Entries whose registered domain matches the active tab. */
  readonly forSite: EntryMetadata[];
  /** Every cached entry, sorted by name (the search corpus). */
  readonly all: EntryMetadata[];
}

export interface TotpView {
  readonly code: string;
  readonly expiresIn: number;
  readonly period: number;
}

/** Why a fill did not complete — surfaced to the popup, not an error. */
export type FillBlockReason =
  | "locked"
  | "no-active-tab"
  | "insecure-page"
  | "domain-mismatch"
  | "not-found"
  | "not-fillable"
  | "decrypt-failed"
  | "network";

export type FillResult =
  | { readonly status: "filled" }
  | { readonly status: "no-form" }
  | { readonly status: "blocked"; readonly reason: FillBlockReason };

export type VaultCommandErrorCode = VaultDataErrorCode | "bad-request";

export type VaultCommandResult =
  | { readonly ok: true; readonly list: VaultListView }
  | { readonly ok: true; readonly reveal: { readonly value: string } }
  | { readonly ok: true; readonly totp: TotpView | null }
  | { readonly ok: true; readonly fill: FillResult }
  | { readonly ok: false; readonly code: VaultCommandErrorCode; readonly message: string };

// ─── Injected effects ─────────────────────────────────────────────────────────

export interface ActiveTab {
  readonly id: number;
  readonly url: string;
}

export interface VaultCommandDeps {
  data: VaultDataService;
  /** Resolve the active tab (activeTab permission grants URL access on invocation). */
  getActiveTab(): Promise<ActiveTab | null>;
  /** Deliver ready field values to a tab's isolated content script. */
  sendFill(tabId: number, fields: readonly FillField[]): Promise<FillOutcome>;
  /** Schedule the clipboard wipe after a value was copied. */
  clipboard: { arm(): void };
  /** Injectable clock for TOTP (ms since epoch). */
  now?: () => number;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function dispatchVaultCommand(
  deps: VaultCommandDeps,
  command: VaultCommand,
): Promise<VaultCommandResult> {
  try {
    switch (command.type) {
      case "vault/list":
        return { ok: true, list: await buildListView(deps) };
      case "vault/sync":
        await deps.data.refresh();
        return { ok: true, list: await buildListView(deps) };
      case "vault/reveal":
        return await revealField(deps, command.vaultId, command.entryId, command.field);
      case "vault/totp":
        return await totpView(deps, command.vaultId, command.entryId);
      case "vault/fill":
        return { ok: true, fill: await fillActiveTab(deps, command.vaultId, command.entryId) };
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch (error) {
    return failure(error);
  }
}

async function buildListView(deps: VaultCommandDeps): Promise<VaultListView> {
  const [all, tab] = await Promise.all([deps.data.getMetadata(), deps.getActiveTab()]);
  const url = tab?.url ?? null;
  const site: SiteInfo = { domain: registrableDomain(url), secure: isSecurePage(url) };
  const forSite = sortByName(entriesForTab(all, url));
  return { site, forSite, all: searchEntries(all, "") };
}

async function revealField(
  deps: VaultCommandDeps,
  vaultId: string,
  entryId: string,
  field: VaultRevealField,
): Promise<VaultCommandResult> {
  const plaintext = await deps.data.revealEntry(vaultId, entryId);

  if (field === "totp") {
    const params = extractTotpParams(plaintext);
    if (!params) return { ok: false, code: "bad-request", message: "Entry has no TOTP" };
    const code = await generateTotp(params, deps.now?.());
    deps.clipboard.arm();
    return { ok: true, reveal: { value: code.code } };
  }

  const value = extractField(plaintext, field);
  if (value === null) return { ok: false, code: "bad-request", message: "Field not available" };
  deps.clipboard.arm();
  return { ok: true, reveal: { value } };
}

async function totpView(
  deps: VaultCommandDeps,
  vaultId: string,
  entryId: string,
): Promise<VaultCommandResult> {
  const plaintext = await deps.data.revealEntry(vaultId, entryId);
  const params = extractTotpParams(plaintext);
  if (!params) return { ok: true, totp: null };
  const code = await generateTotp(params, deps.now?.());
  return { ok: true, totp: { code: code.code, expiresIn: code.expiresIn, period: code.period } };
}

async function fillActiveTab(
  deps: VaultCommandDeps,
  vaultId: string,
  entryId: string,
): Promise<FillResult> {
  const tab = await deps.getActiveTab();
  if (!tab) return { status: "blocked", reason: "no-active-tab" };
  if (!isSecurePage(tab.url)) return { status: "blocked", reason: "insecure-page" };

  const meta = (await deps.data.getMetadata()).find(
    (entry) => entry.id === entryId && entry.vaultId === vaultId,
  );
  if (!meta) return { status: "blocked", reason: "not-found" };
  // Re-check the origin gate at click time, not just when the list was drawn.
  if (!matchesTab(tab.url, meta.urlDomain)) return { status: "blocked", reason: "domain-mismatch" };
  if (meta.type !== ENTRY_TYPE_CREDENTIAL) return { status: "blocked", reason: "not-fillable" };

  let plaintext: EntryPlaintext;
  try {
    plaintext = await deps.data.revealEntry(vaultId, entryId);
  } catch (error) {
    return { status: "blocked", reason: fillReasonFor(error) };
  }
  if (plaintext.type !== ENTRY_TYPE_CREDENTIAL) return { status: "blocked", reason: "not-fillable" };

  const fields: FillField[] = [];
  if (plaintext.username) fields.push({ kind: "username", value: plaintext.username });
  fields.push({ kind: "password", value: plaintext.password });

  const outcome = await deps.sendFill(tab.id, fields);
  return outcome.ok ? { status: "filled" } : { status: "no-form" };
}

// ─── Plaintext extraction ─────────────────────────────────────────────────────

function extractField(plaintext: EntryPlaintext, field: VaultRevealField): string | null {
  if (field === "value") {
    return plaintext.type === ENTRY_TYPE_KEY ? plaintext.value : null;
  }
  if (plaintext.type !== ENTRY_TYPE_CREDENTIAL) return null;
  if (field === "username") return plaintext.username;
  if (field === "password") return plaintext.password;
  return null;
}

/**
 * The entry's TOTP seed, from the credential's `otpauth://` URI first, else the
 * first `totp` custom field (its value is already a parsed {@link TotpParams}).
 */
function extractTotpParams(plaintext: EntryPlaintext): TotpParams | null {
  if (plaintext.type === ENTRY_TYPE_CREDENTIAL && plaintext.totp) {
    const parsed = parseOtpauthUri(plaintext.totp);
    if (parsed) return parsed;
  }
  for (const fieldEntry of plaintext.fields ?? []) {
    if (fieldEntry.type === "totp" && typeof fieldEntry.value === "object" && fieldEntry.value !== null) {
      return fieldEntry.value;
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sortByName(entries: readonly EntryMetadata[]): EntryMetadata[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function fillReasonFor(error: unknown): FillBlockReason {
  if (error instanceof VaultDataError) {
    if (error.code === "locked") return "locked";
    if (error.code === "decrypt-failed") return "decrypt-failed";
  }
  return "network";
}

function failure(error: unknown): VaultCommandResult {
  if (error instanceof VaultDataError) {
    return { ok: false, code: error.code, message: error.message };
  }
  // Never surface a raw error (could carry a value); collapse to network.
  return { ok: false, code: "network", message: "Vault command failed" };
}

// ─── Runtime message adapter ──────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isVaultCommand(value: unknown): value is VaultCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as { type?: unknown };
  switch (command.type) {
    case "vault/list":
    case "vault/sync":
      return true;
    case "vault/reveal": {
      const c = value as { vaultId?: unknown; entryId?: unknown; field?: unknown };
      return (
        isString(c.vaultId) &&
        isString(c.entryId) &&
        (c.field === "username" ||
          c.field === "password" ||
          c.field === "value" ||
          c.field === "totp")
      );
    }
    case "vault/totp":
    case "vault/fill": {
      const c = value as { vaultId?: unknown; entryId?: unknown };
      return isString(c.vaultId) && isString(c.entryId);
    }
    default:
      return false;
  }
}

/**
 * Adapt a raw `chrome.runtime.onMessage` payload onto the vault command surface.
 * Returns a response for recognised commands, or `null` for anything else so the
 * session listener can handle it. Never throws.
 */
export async function handleVaultRuntimeMessage(
  deps: VaultCommandDeps,
  raw: unknown,
): Promise<VaultCommandResult | null> {
  if (!isVaultCommand(raw)) return null;
  return dispatchVaultCommand(deps, raw);
}
