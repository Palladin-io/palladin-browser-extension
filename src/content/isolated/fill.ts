/** Isolated-world user fills. Inline targets use the same credential analysis as
 * native live login; popup/generator/card fills preserve their existing contract.
 * The worker authorizes delivery. This module rechecks the live DOM binding. */

import type { FillField, FillOutcome, FillRequestMessage } from "@shared/messaging";
import { matchesTab } from "@shared/security/domain";

type TextLikeInput = HTMLInputElement;
type FillControl = HTMLInputElement | HTMLTextAreaElement;

import { isFillable, isCurrentLoginTarget, type LoginTarget } from './credential-form-analysis';
import { credentialScopeFor, isCredentialAction } from './login-controls';
import { queryOpenElements } from './open-dom';
export { isFillable, isCurrentLoginTarget, loginTargetFor, type LoginTarget } from './credential-form-analysis';

const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);
const CARD_AUTOCOMPLETE_KIND: Readonly<Record<string, FillField["kind"]>> = {
  "cc-name": "cardholder",
  "cc-number": "card-number",
  "cc-exp-month": "card-expiry-month",
  "cc-exp-year": "card-expiry-year",
  "cc-exp": "card-expiry",
};

function firstFillablePassword(doc: Document): HTMLInputElement | null {
  for (const input of doc.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    if (isFillable(input)) return input;
  }
  return null;
}

/**
 * The nearest fillable text/email/tel field associated with the password's form.
 * Prefer the last matching field before the password, then the first one after
 * it so discovery and fill accept the same form-associated control topologies.
 */
function usernameFieldFor(
  doc: Document,
  password: HTMLInputElement,
): TextLikeInput | null {
  const candidates = password.form === null
    ? Array.from(doc.querySelectorAll<HTMLInputElement>("input"))
    : Array.from(password.form.elements).filter(
        (control): control is HTMLInputElement => control instanceof HTMLInputElement,
      );
  let previous: TextLikeInput | null = null;
  let following: TextLikeInput | null = null;
  let reachedPassword = false;
  for (const input of candidates) {
    if (input === password) {
      reachedPassword = true;
      continue;
    }
    const type = input.getAttribute("type")?.toLowerCase() ?? "";
    if (!USERNAME_TYPES.has(type) || !isFillable(input)) continue;
    if (!reachedPassword) previous = input;
    else if (following === null) following = input;
  }
  return previous ?? (password.form === null ? null : following);
}

/** Set a controlled input's value so React/Vue-style frameworks observe the change. */
function setFieldValue(input: FillControl, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Perform the fill against `doc`. Returns `{ ok: false, reason: "no-form" }`
 * when there is no fillable password field — the popup surfaces that as "No
 * login form found". A username value is written only when a matching field is
 * found; a lone password still fills.
 */
export function performFill(doc: Document, fields: readonly FillField[]): FillOutcome {
  const generated = fields.find((field) => field.kind === "generated");
  if (generated) {
    const active = doc.activeElement;
    const target = active instanceof HTMLInputElement && isFillable(active)
      ? active
      : firstFillablePassword(doc);
    if (!target) return { ok: false, reason: "no-form" };
    setFieldValue(target, generated.value);
    return { ok: true };
  }

  const cardFields = fields.filter((field) => field.kind.startsWith("card-")
    || field.kind === "cardholder"
    || field.kind === "billing-address");
  if (cardFields.length > 0) return performCardFill(doc, cardFields);

  const password = firstFillablePassword(doc);
  if (!password) return { ok: false, reason: "no-form" };

  const username = usernameFieldFor(doc, password);
  for (const field of fields) {
    if (field.kind === "password") setFieldValue(password, field.value);
    else if (field.kind === "username" && username) setFieldValue(username, field.value);
  }
  return { ok: true };
}

/** Fill only the exact login pair captured by inline discovery. */
export function performLoginTargetFill(
  target: LoginTarget,
  fields: readonly FillField[],
): FillOutcome {
  const controls = fields.flatMap(field => field.kind === "username" && target.username !== null
    ? [{ input: target.username, value: field.value }]
    : field.kind === "password" && target.password !== null ? [{ input: target.password, value: field.value }] : []);
  const expected = (input: HTMLInputElement) => controls.find(control => control.input === input)?.value;
  const compatible = () => isCurrentLoginTarget(target)
    && [target.username, target.password].every(input => input === null || input.value === "" || input.value === expected(input));
  clearFillReceipt(target);
  if (controls.length === 0 || !compatible()) return { ok: false, reason: "no-form" };
  const completed: typeof controls = [];
  for (const control of controls) {
    if (!compatible() || completed.some(done => done.input.value !== done.value)) {
      return { ok: false, reason: "no-form" };
    }
    // Preserve matching values without replaying framework input/change handlers.
    if (control.input.value !== control.value) setFieldValue(control.input, control.value);
    completed.push(control);
  }
  if (!compatible() || !completed.every(control => control.input.value === control.value)) {
    return { ok: false, reason: "no-form" };
  }
  rememberFill(target);
  return { ok: true };
}

interface FillReceipt {
  readonly snapshot: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}
const fillReceipts = new WeakMap<LoginTarget, FillReceipt>();
const FILL_RECEIPT_TTL_MS = 5_000;

function targetValues(target: LoginTarget): string {
  return JSON.stringify([target.username?.value ?? null, target.password?.value ?? null]);
}
function clearFillReceipt(target: LoginTarget): void {
  const receipt = fillReceipts.get(target);
  if (receipt) clearTimeout(receipt.timer);
  fillReceipts.delete(target);
}
function rememberFill(target: LoginTarget): void {
  const timer = setTimeout(() => fillReceipts.delete(target), FILL_RECEIPT_TTL_MS);
  fillReceipts.set(target, { snapshot: targetValues(target), url: target.form.ownerDocument.location.href,
    expiresAt: performance.now() + FILL_RECEIPT_TTL_MS, timer });
}
/** One-use local receipt from the actual approved DOM write, never a worker-reply snapshot. */
export async function submitFilledLoginTarget(target: LoginTarget, stillCurrent: () => boolean): Promise<boolean> {
  const receipt = fillReceipts.get(target);
  clearFillReceipt(target);
  if (!receipt) return false;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const anchor = target.username ?? target.password;
  return anchor !== null && performance.now() < receipt.expiresAt && stillCurrent()
    && target.form.ownerDocument.location.href === receipt.url && isCurrentLoginTarget(target)
    && targetValues(target) === receipt.snapshot && submitLoginForm(anchor, target);
}

/** Final isolated-world binding check immediately before any DOM write. */
export function performBoundFill(
  doc: Document,
  message: FillRequestMessage,
  currentUrl: string,
  currentDocumentId: string,
  loginTarget: LoginTarget | null = null,
): FillOutcome {
  if (currentDocumentId !== message.documentId) {
    return { ok: false, reason: "target-changed" };
  }
  try {
    const current = new URL(currentUrl);
    if (current.protocol !== "https:" || current.origin !== message.expectedOrigin) {
      return { ok: false, reason: "target-changed" };
    }
  } catch {
    return { ok: false, reason: "target-changed" };
  }
  if (message.expectedDomain !== null && !matchesTab(currentUrl, message.expectedDomain)) {
    return { ok: false, reason: "target-changed" };
  }
  const outcome = message.loginTargetId === null
    ? performFill(doc, message.fields)
    : loginTarget === null
      ? { ok: false as const, reason: "no-form" as const }
      : performLoginTargetFill(loginTarget, message.fields);
  if (!outcome.ok || !message.submit) return outcome;

  const password = message.loginTargetId === null
    ? firstFillablePassword(doc)
    : loginTarget?.username ?? loginTarget?.password ?? null;
  if (password === null || !submitLoginForm(password, loginTarget ?? undefined)) {
    return { ok: false, reason: "no-form" };
  }
  return { ok: true };
}

/** Submit only the exact form that owns the filled login field. */
export function submitLoginForm(input: HTMLInputElement, target?: LoginTarget): boolean {
  if (target !== undefined && (!isCurrentLoginTarget(target)
    || (input !== target.username && input !== target.password))) return false;
  if (target !== undefined && !(target.form instanceof HTMLFormElement)) {
    const actions = queryOpenElements(target.form, 'button, input[type="submit"], input[type="button"]')
      .filter((action): action is HTMLButtonElement | HTMLInputElement =>
        (action instanceof HTMLButtonElement || action instanceof HTMLInputElement)
        && (action.type === 'submit' || action.type === 'button')
        && isCredentialAction(action) && credentialScopeFor(action) === target.form);
    if (actions.length !== 1) return false;
    try { actions[0]?.click(); return true; } catch { return false; }
  }
  const form = input.isConnected ? input.form : null;
  if (form === null) return false;
  const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>(
    'button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])',
  );
  try {
    if (submitter !== null) form.requestSubmit(submitter);
    else form.requestSubmit();
    return true;
  } catch {
    return false;
  }
}

function performCardFill(doc: Document, fields: readonly FillField[]): FillOutcome {
  const values = new Map(fields.map((field) => [field.kind, field.value]));
  const filledKinds = new Set<FillField["kind"]>();
  for (const input of doc.querySelectorAll<FillControl>("input[autocomplete], textarea[autocomplete]")) {
    if (!isFillable(input)) continue;
    const tokens = (input.getAttribute("autocomplete") ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const fieldName = tokens.at(-1) ?? "";
    let kind = CARD_AUTOCOMPLETE_KIND[fieldName];
    if ((fieldName === "street-address" || fieldName === "address-line1")
      && tokens.includes("billing")) {
      kind = "billing-address";
    }
    // Deliberately ignore cc-csc and every label/name heuristic. A neutral
    // custom field must never become payment authentication data by accident.
    if (kind === undefined || filledKinds.has(kind)) continue;
    const value = values.get(kind);
    if (value === undefined || value.length === 0) continue;
    setFieldValue(input, value);
    filledKinds.add(kind);
  }
  return filledKinds.size > 0 ? { ok: true } : { ok: false, reason: "no-form" };
}
