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
  ManualEntrySaveInput,
  ManualEntrySaveResult,
} from "./protocol2/service";
import {
  VaultDataError,
  type VaultDataErrorCode,
} from "./errors";

/** UI remounts (including side-panel tab changes) reuse a recent sync. */
export const UI_VAULT_REFRESH_MAX_AGE_MS = 15 * 60_000;

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
  | { readonly type: "vault/credential-username"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/totp"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/fill"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/login"; readonly vaultId: string; readonly entryId: string }
  | { readonly type: "vault/fill-generated"; readonly value: string }
  | { readonly type: "vault/entry-save"; readonly entry: ManualEntrySaveInput }
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
  | "navigation-failed"
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
  | { readonly ok: true; readonly credentialUsername: { readonly value: string } }
  | { readonly ok: true; readonly totp: TotpView | null }
  | { readonly ok: true; readonly fill: FillResult }
  | { readonly ok: true; readonly entrySave: ManualEntrySaveResult }
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
  entryWriter?: { saveEntry(input: ManualEntrySaveInput): Promise<ManualEntrySaveResult> };
  /** Resolve the active tab (activeTab permission grants URL access on invocation). */
  getActiveTab(): Promise<ActiveTab | null>;
  /** Open the reviewed HTTPS target and resolve its exact live top-frame document. */
  openLoginTab(url: string): Promise<ActiveTab | null>;
  /** Deliver values only to the exact top-frame document prepared pre-decrypt. */
  sendFill(
    target: ActiveTab,
    expectedDomain: string | null,
    fields: readonly FillField[],
    submit: boolean,
    loginTargetId?: string,
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
        await deps.data.refreshIfStale(UI_VAULT_REFRESH_MAX_AGE_MS);
        return { ok: true, list: await buildListView(deps) };
      case "vault/reveal":
        if (!deps.clipboard.available) {
          return { ok: false, code: "bad-request", message: "Copy is unavailable on this browser" };
        }
        return await revealField(deps, command.vaultId, command.entryId, command.field);
      case "vault/credential-username":
        return await revealCredentialUsername(deps, command.vaultId, command.entryId);
      case "vault/totp":
        return await totpView(deps, command.vaultId, command.entryId);
      case "vault/fill":
        return { ok: true, fill: await fillActiveTab(deps, command.vaultId, command.entryId) };
      case "vault/login":
        return { ok: true, fill: await openAndFillLogin(deps, command.vaultId, command.entryId) };
      case "vault/fill-generated":
        return { ok: true, fill: await fillGeneratedValue(deps, command.value) };
      case "vault/entry-save":
        if (!deps.entryWriter) {
          return { ok: false, code: "network", message: "Entry saving is unavailable" };
        }
        return { ok: true, entrySave: await deps.entryWriter.saveEntry(command.entry) };
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
  const outcome = await deps.sendFill(tab, null, [{ kind: "generated", value }], false);
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

async function revealCredentialUsername(
  deps: VaultCommandDeps,
  vaultId: string,
  entryId: string,
): Promise<VaultCommandResult> {
  const plaintext = await deps.data.revealEntry(vaultId, entryId);
  const value = extractField(plaintext, "username");
  return value === null
    ? { ok: false, code: "bad-request", message: "Entry has no username" }
    : { ok: true, credentialUsername: { value } };
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
  return fillPreparedEntry(deps, meta, tab);
}

/**
 * Inline-only fill bound to the content script's authenticated tab/document.
 * A related-host scope is a one-shot opt-in from the closed Shadow DOM menu;
 * it never changes the entry and is never eligible for automatic fill.
 */
export async function fillInlineSelectedEntry(
  deps: VaultCommandDeps,
  tab: ActiveTab,
  vaultId: string,
  entryId: string,
  scope: "exact" | "related",
  loginTargetId: string,
): Promise<FillResult> {
  if (!isSecurePage(tab.url)) return { status: "blocked", reason: "insecure-page" };
  const meta = (await deps.data.getMetadata()).find(
    (entry) => entry.id === entryId && entry.vaultId === vaultId,
  );
  if (!meta) return { status: "blocked", reason: "not-found" };
  if (meta.type !== ENTRY_TYPE_CREDENTIAL || !meta.urlDomain) {
    return { status: "blocked", reason: "not-fillable" };
  }
  const related = scope === "related";
  if (!matchesTab(tab.url, meta.urlDomain, related ? { exactSubdomain: false } : undefined)) {
    return { status: "blocked", reason: "domain-mismatch" };
  }
  return fillPreparedEntry(deps, meta, tab, related, false, loginTargetId);
}

async function openAndFillLogin(
  deps: VaultCommandDeps,
  vaultId: string,
  entryId: string,
): Promise<FillResult> {
  const meta = (await deps.data.getMetadata()).find(
    (entry) => entry.id === entryId && entry.vaultId === vaultId,
  );
  if (!meta) return { status: "blocked", reason: "not-found" };
  if (meta.type !== ENTRY_TYPE_CREDENTIAL || !meta.urlDomain) {
    return { status: "blocked", reason: "not-fillable" };
  }

  // "Log in" is the resilient primary action: use the current exact HTTPS
  // document when it already owns a login form, otherwise open the stored host
  // and fill its new, browser-authenticated top-frame document. A security
  // failure never silently falls through to navigation.
  const active = await deps.getActiveTab();
  if (active !== null && isSecurePage(active.url) && matchesTab(active.url, meta.urlDomain)) {
    const current = await fillPreparedEntry(deps, meta, active, false, true);
    if (current.status !== "no-form") return current;
  }

  const url = loginUrlForDomain(meta.urlDomain);
  if (url === null) return { status: "blocked", reason: "domain-mismatch" };

  // Navigation carries only the already-decrypted discovery host. The password
  // is not opened until the new tab has a live, exact top-frame document on the
  // same HTTPS host.
  const tab = await deps.openLoginTab(url);
  if (tab === null) return { status: "blocked", reason: "navigation-failed" };
  if (!isSecurePage(tab.url) || !matchesTab(tab.url, meta.urlDomain)) {
    return { status: "blocked", reason: "domain-mismatch" };
  }
  return fillPreparedEntry(deps, meta, tab, false, true);
}

async function fillPreparedEntry(
  deps: VaultCommandDeps,
  meta: EntryMetadata,
  tab: ActiveTab,
  allowRelatedDomain = false,
  submit = false,
  loginTargetId?: string,
): Promise<FillResult> {
  // Re-check the origin gate at click time, not just when the list was drawn.
  if (meta.type === ENTRY_TYPE_CREDENTIAL && !matchesTab(
    tab.url,
    meta.urlDomain,
    allowRelatedDomain ? { exactSubdomain: false } : undefined,
  )) {
    return { status: "blocked", reason: "domain-mismatch" };
  }
  if (meta.type !== ENTRY_TYPE_CREDENTIAL && meta.type !== ENTRY_TYPE_CREDIT_CARD) {
    return { status: "blocked", reason: "not-fillable" };
  }
  const cardTargetHost = meta.type === ENTRY_TYPE_CREDIT_CARD
    ? exactHttpsHost(tab.url)
    : null;
  if (meta.type === ENTRY_TYPE_CREDIT_CARD && cardTargetHost === null) {
    return { status: "blocked", reason: "domain-mismatch" };
  }

  let plaintext: MemberSecretV1;
  try {
    plaintext = await deps.data.revealEntry(meta.vaultId, meta.id);
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
    // Cards do not carry a persistent website association. The explicit popup
    // action is therefore bound to this one exact, live HTTPS host and document.
    const outcome = await deps.sendFill(tab, cardTargetHost, fields, false);
    return fillResult(outcome);
  }
  if (!isCredential(plaintext)) return { status: "blocked", reason: "not-fillable" };
  const currentDomain = plaintext.content.urlDomain;
  if (!matchesTab(
    tab.url,
    currentDomain,
    allowRelatedDomain ? { exactSubdomain: false } : undefined,
  )) {
    return { status: "blocked", reason: "domain-mismatch" };
  }

  const fields: FillField[] = [];
  const username = credentialUsername(plaintext);
  if (username) fields.push({ kind: "username", value: username });
  fields.push({ kind: "password", value: credentialPassword(plaintext) });

  // The isolated-world check stays exact even after a one-shot related-host
  // consent: bind the final DOM write to the live target host, never to the
  // broader registrable domain.
  const expectedDomain = allowRelatedDomain ? exactHttpsHost(tab.url) : currentDomain;
  if (expectedDomain === null) return { status: "blocked", reason: "domain-mismatch" };
  const outcome = loginTargetId === undefined
    ? await deps.sendFill(tab, expectedDomain, fields, submit)
    : await deps.sendFill(tab, expectedDomain, fields, submit, loginTargetId);
  return fillResult(outcome);
}

function exactHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return parsed.protocol === "https:" && registrableDomain(host) !== null ? host : null;
  } catch {
    return null;
  }
}

function loginUrlForDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0 || registrableDomain(normalized) === null) return null;
  try {
    const url = new URL(`https://${normalized}/`);
    return url.username === ""
      && url.password === ""
      && url.port === ""
      && url.hostname === normalized
      ? url.toString()
      : null;
  } catch {
    return null;
  }
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
    case "vault/entry-save": {
      const c = value as { entry?: unknown };
      return isManualEntrySaveInput(c.entry);
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
    case "vault/fill":
    case "vault/login":
    case "vault/credential-username": {
      const c = value as { vaultId?: unknown; entryId?: unknown };
      return isString(c.vaultId) && isString(c.entryId);
    }
    default:
      return false;
  }
}

function isManualEntrySaveInput(value: unknown): value is ManualEntrySaveInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!validLabel(entry.label) || typeof entry.entryType !== "string") return false;
  const optionalNotes = entry.notes === undefined
    || (typeof entry.notes === "string" && entry.notes.length <= 4096);
  const optionalCustomFields = entry.customFields === undefined || isManualCustomFields(entry.customFields);
  if (!optionalNotes || !optionalCustomFields) return false;
  switch (entry.entryType) {
    case "credential":
      return hasOnlyKeys(entry, ["entryType", "label", "username", "password", "url", "notes", "customFields"])
        && typeof entry.username === "string" && entry.username.length <= 512
        && typeof entry.password === "string" && entry.password.length > 0 && entry.password.length <= 4096
        && (entry.url === undefined || (typeof entry.url === "string" && entry.url.length <= 2048));
    case "key":
      return hasOnlyKeys(entry, ["entryType", "label", "value", "notes", "customFields"])
        && typeof entry.value === "string" && entry.value.length > 0 && entry.value.length <= 16_384;
    case "script":
      return hasOnlyKeys(entry, ["entryType", "label", "source", "interpreter", "notes", "customFields"])
        && typeof entry.source === "string" && entry.source.length > 0 && entry.source.length <= 65_536
        && (entry.interpreter === "bash" || entry.interpreter === "sh"
          || entry.interpreter === "node" || entry.interpreter === "python");
    case "creditCard":
      return hasOnlyKeys(entry, [
        "entryType", "label", "cardholderName", "cardNumber", "expiryMonth",
        "expiryYear", "billingAddress", "notes", "customFields",
      ]) && isCreditCardSaveInput(Object.fromEntries(
        Object.entries(entry).filter(([key]) => key !== "entryType"),
      ));
    default:
      return false;
  }
}

function isManualCustomFields(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const field = item as Record<string, unknown>;
    if (!hasOnlyKeys(field, ["id", "label", "type", "value"])) return false;
    if (typeof field.id !== "string" || !/^custom:[a-zA-Z0-9_-]{8,128}$/.test(field.id) || ids.has(field.id)) return false;
    if (typeof field.label !== "string" || field.label.trim().length === 0 || field.label.length > 80) return false;
    if (field.type !== "text" && field.type !== "multiline" && field.type !== "concealed") return false;
    if (typeof field.value !== "string" || field.value.length > 16_384) return false;
    ids.add(field.id);
  }
  return true;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCreditCardSaveInput(value: unknown): value is CreditCardSaveInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  const keys = ["label", "cardholderName", "cardNumber", "expiryMonth", "expiryYear", "billingAddress", "notes", "customFields"];
  if (!Object.keys(card).every((key) => keys.includes(key))) return false;
  return typeof card.label === "string" && card.label.trim().length > 0 && card.label.length <= 256
    && typeof card.cardholderName === "string" && card.cardholderName.length <= 256
    && typeof card.cardNumber === "string" && /^[0-9 -]{8,32}$/.test(card.cardNumber)
    && typeof card.expiryMonth === "string" && /^(0[1-9]|1[0-2])$/.test(card.expiryMonth)
    && typeof card.expiryYear === "string" && /^[0-9]{4}$/.test(card.expiryYear)
    && (card.billingAddress === undefined
      || (typeof card.billingAddress === "string" && card.billingAddress.length <= 2048))
    && (card.notes === undefined || (typeof card.notes === "string" && card.notes.length <= 4096))
    && (card.customFields === undefined || isManualCustomFields(card.customFields));
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
