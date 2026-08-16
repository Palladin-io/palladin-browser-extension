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
 *   - fill re-resolves the active tab and re-checks the registered host and HTTPS at
 *     the moment of the click (not just when the list was rendered), decrypts,
 *     and only then hands ready values to the tab's content script.
 *
 * Everything Chrome-adjacent (active tab, fill transport, clipboard arm) is
 * injected so `dispatchVaultCommand` is a pure async function over fakes.
 */

import {
  generateTotp,
  type MemberSecretV1,
  type TotpParams,
} from "@palladin/crypto";

import type { FillField, FillOutcome } from "@shared/messaging";

import { isSecurePage, matchesTab, registrableDomain } from "./domain";
import type { VaultDataSource } from "./data-source";
import {
  ENTRY_TYPE_CREDENTIAL,
  ENTRY_TYPE_CREDIT_CARD,
  entriesForTab,
  searchEntries,
  type EntryMetadata,
} from "./entry-metadata";
import type {
  CreditCardSaveInput,
  CreditCardSaveResult,
} from "./protocol2/service";
import {
  VaultDataError,
  type VaultDataErrorCode,
} from "./errors";

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
  | { readonly type: "vault/fill"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/fill-generated"; readonly value: string }
  | { readonly type: "vault/card-save"; readonly card: CreditCardSaveInput }
  | { readonly type: "vault/clipboard-arm" };

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
  | "target-changed"
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
  | { readonly ok: true; readonly cardSave: CreditCardSaveResult }
  | { readonly ok: true; readonly clipboardArmed: true }
  | { readonly ok: false; readonly code: VaultCommandErrorCode; readonly message: string };

// ─── Injected effects ─────────────────────────────────────────────────────────

export interface ActiveTab {
  readonly id: number;
  readonly url: string;
  /** Isolated page-load id, checked again inside that document. */
  readonly documentId: string;
  /** Browser-issued target used by tabs.sendMessage routing. */
  readonly browserDocumentId: string;
}

export interface VaultCommandDeps {
  data: VaultDataSource;
  cardWriter?: { saveCreditCard(input: CreditCardSaveInput): Promise<CreditCardSaveResult> };
  /** Resolve the active tab (activeTab permission grants URL access on invocation). */
  getActiveTab(): Promise<ActiveTab | null>;
  /** Deliver values only to the exact top-frame document prepared pre-decrypt. */
  sendFill(
    target: ActiveTab,
    expectedDomain: string | null,
    fields: readonly FillField[],
  ): Promise<FillOutcome>;
  /** Schedule the clipboard wipe after a value was copied. */
  clipboard: { readonly available: boolean; arm(): void };
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
        if (!deps.clipboard.available) {
          return { ok: false, code: "bad-request", message: "Copy is unavailable on this browser" };
        }
        return await revealField(deps, command.vaultId, command.entryId, command.field);
      case "vault/totp":
        return await totpView(deps, command.vaultId, command.entryId);
      case "vault/fill":
        return { ok: true, fill: await fillActiveTab(deps, command.vaultId, command.entryId) };
      case "vault/fill-generated":
        return { ok: true, fill: await fillGeneratedValue(deps, command.value) };
      case "vault/card-save":
        if (!deps.cardWriter) {
          return { ok: false, code: "network", message: "Card saving is unavailable" };
        }
        return { ok: true, cardSave: await deps.cardWriter.saveCreditCard(command.card) };
      case "vault/clipboard-arm":
        if (!deps.clipboard.available) {
          return { ok: false, code: "bad-request", message: "Clipboard wipe is unavailable" };
        }
        deps.clipboard.arm();
        return { ok: true, clipboardArmed: true };
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch (error) {
    return failure(error);
  }
}

async function fillGeneratedValue(deps: VaultCommandDeps, value: string): Promise<FillResult> {
  const tab = await deps.getActiveTab();
  if (!tab) return { status: "blocked", reason: "no-active-tab" };
  if (!isSecurePage(tab.url)) return { status: "blocked", reason: "insecure-page" };
  const outcome = await deps.sendFill(tab, null, [{ kind: "generated", value }]);
  return fillResult(outcome);
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
  if (meta.type === ENTRY_TYPE_CREDENTIAL && !matchesTab(tab.url, meta.urlDomain)) {
    return { status: "blocked", reason: "domain-mismatch" };
  }
  if (meta.type !== ENTRY_TYPE_CREDENTIAL && meta.type !== ENTRY_TYPE_CREDIT_CARD) {
    return { status: "blocked", reason: "not-fillable" };
  }

  let plaintext: MemberSecretV1;
  try {
    plaintext = await deps.data.revealEntry(vaultId, entryId);
  } catch (error) {
    return { status: "blocked", reason: fillReasonFor(error) };
  }
  if (plaintext.entryType === "creditCard") {
    const card = plaintext.content;
    const fields: FillField[] = [
      { kind: "cardholder", value: card.cardholderName },
      { kind: "card-number", value: card.cardNumber },
      { kind: "card-expiry-month", value: card.expiryMonth },
      { kind: "card-expiry-year", value: card.expiryYear },
      { kind: "card-expiry", value: `${card.expiryMonth}/${card.expiryYear.slice(-2)}` },
      ...(card.billingAddress
        ? [{ kind: "billing-address", value: card.billingAddress } as const]
        : []),
    ];
    const outcome = await deps.sendFill(tab, null, fields);
    return fillResult(outcome);
  }
  if (!isCredential(plaintext)) return { status: "blocked", reason: "not-fillable" };
  const currentDomain = plaintext.content.urlDomain;
  if (!matchesTab(tab.url, currentDomain)) {
    return { status: "blocked", reason: "domain-mismatch" };
  }

  const fields: FillField[] = [];
  const username = credentialUsername(plaintext);
  if (username) fields.push({ kind: "username", value: username });
  fields.push({ kind: "password", value: credentialPassword(plaintext) });

  const outcome = await deps.sendFill(tab, currentDomain, fields);
  return fillResult(outcome);
}

// ─── Plaintext extraction ─────────────────────────────────────────────────────

function extractField(
  plaintext: MemberSecretV1,
  field: VaultRevealField,
): string | null {
  if (field === "value") {
    return plaintext.entryType === "key" ? plaintext.content.value : null;
  }
  if (!isCredential(plaintext)) return null;
  if (field === "username") return credentialUsername(plaintext);
  if (field === "password") return credentialPassword(plaintext);
  return null;
}

/**
 * The entry's TOTP seed, from the credential's `otpauth://` URI first, else the
 * first `totp` custom field (its value is already a parsed {@link TotpParams}).
 */
function extractTotpParams(plaintext: MemberSecretV1): TotpParams | null {
  if (plaintext.entryType === "credential" && plaintext.content.totp) {
    const canonical = plaintext.content.totp;
    return {
      secret: canonical.secret,
      algorithm: canonical.algorithm,
      digits: canonical.digits,
      period: canonical.period,
      ...(canonical.issuer ? { issuer: canonical.issuer } : {}),
      ...(canonical.account ? { account: canonical.account } : {}),
    };
  }
  for (const fieldEntry of plaintext.content.customFields) {
    if (fieldEntry.type === "totp" && isTotpParams(fieldEntry.value)) return fieldEntry.value;
  }
  return null;
}

function isCredential(
  plaintext: MemberSecretV1,
): plaintext is Extract<MemberSecretV1, { entryType: "credential" }> {
  return plaintext.entryType === "credential";
}

function credentialUsername(
  plaintext: Extract<MemberSecretV1, { entryType: "credential" }>,
): string {
  return plaintext.content.username;
}

function credentialPassword(
  plaintext: Extract<MemberSecretV1, { entryType: "credential" }>,
): string {
  return plaintext.content.password;
}

function isTotpParams(value: unknown): value is TotpParams {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TotpParams>;
  return typeof candidate.secret === "string"
    && (candidate.algorithm === "SHA1" || candidate.algorithm === "SHA256" || candidate.algorithm === "SHA512")
    && typeof candidate.digits === "number"
    && typeof candidate.period === "number";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sortByName(entries: readonly EntryMetadata[]): EntryMetadata[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function fillResult(outcome: FillOutcome): FillResult {
  if (outcome.ok) return { status: "filled" };
  return outcome.reason === "target-changed"
    ? { status: "blocked", reason: "target-changed" }
    : { status: "no-form" };
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
    case "vault/clipboard-arm":
      return true;
    case "vault/fill-generated": {
      const c = value as { value?: unknown };
      return isString(c.value) && c.value.length > 0 && c.value.length <= 4096;
    }
    case "vault/card-save": {
      const c = value as { card?: unknown };
      return isCreditCardSaveInput(c.card);
    }
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

function isCreditCardSaveInput(value: unknown): value is CreditCardSaveInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  const keys = ["label", "cardholderName", "cardNumber", "expiryMonth", "expiryYear", "billingAddress", "notes"];
  if (!Object.keys(card).every((key) => keys.includes(key))) return false;
  return typeof card.label === "string" && card.label.trim().length > 0 && card.label.length <= 256
    && typeof card.cardholderName === "string" && card.cardholderName.length <= 256
    && typeof card.cardNumber === "string" && /^[0-9 -]{8,32}$/.test(card.cardNumber)
    && typeof card.expiryMonth === "string" && /^(0[1-9]|1[0-2])$/.test(card.expiryMonth)
    && typeof card.expiryYear === "string" && /^[0-9]{4}$/.test(card.expiryYear)
    && (card.billingAddress === undefined
      || (typeof card.billingAddress === "string" && card.billingAddress.length <= 2048))
    && (card.notes === undefined || (typeof card.notes === "string" && card.notes.length <= 4096));
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
