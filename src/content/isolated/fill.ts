/**
 * The minimal, fallback fill for CVT-368 (plan §1 user autofill).
 *
 * This is deliberately the simplest heuristic that works for a standard login
 * form: find the first fillable `input[type=password]`, and the nearest fillable
 * text/email field before it (same form when there is one). Full field detection
 * — richer heuristics, multi-step logins, an inline menu — is CVT-371/372; this
 * only has to cover the common case and fail cleanly ("No login form found")
 * otherwise.
 *
 * It runs in the isolated world after the worker has cleared every gate, so the
 * incoming values are already authorised. Nothing here decides whether to fill.
 * The React-compatible value setter mirrors how password managers drive
 * controlled inputs so frameworks observe the change.
 */

import type { FillField, FillOutcome, FillRequestMessage } from "@shared/messaging";
import { matchesTab } from "@shared/security/domain";

type TextLikeInput = HTMLInputElement;
type FillControl = HTMLInputElement | HTMLTextAreaElement;

const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);
const CARD_AUTOCOMPLETE_KIND: Readonly<Record<string, FillField["kind"]>> = {
  "cc-name": "cardholder",
  "cc-number": "card-number",
  "cc-exp-month": "card-expiry-month",
  "cc-exp-year": "card-expiry-year",
  "cc-exp": "card-expiry",
};

/** Fail closed for disabled, hidden, or page-CSS-hidden controls. */
export function isFillable(input: FillControl): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.hidden || (input instanceof HTMLInputElement && input.type === "hidden")) return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const style = input.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
    return false;
  }
  if (/opacity\s*:\s*0(?:\D|$)/i.test(style) || /pointer-events\s*:\s*none/i.test(style)) {
    return false;
  }
  const view = input.ownerDocument.defaultView;
  if (view === null) return false;
  for (let element: HTMLElement | null = input; element !== null; element = element.parentElement) {
    if (element.hidden
      || element.hasAttribute("inert")
      || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const computed = view.getComputedStyle(element);
    if (computed.display === "none"
      || computed.visibility === "hidden"
      || computed.visibility === "collapse"
      || Number.parseFloat(computed.opacity) === 0
      || computed.pointerEvents === "none"
      || computed.getPropertyValue("content-visibility") === "hidden") {
      return false;
    }
  }
  return true;
}

function firstFillablePassword(doc: Document): HTMLInputElement | null {
  for (const input of doc.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    if (isFillable(input)) return input;
  }
  return null;
}

/**
 * The fillable text/email/tel field immediately preceding the password in DOM
 * order - scoped to all controls associated with the password's form when it
 * has one, else the document.
 * "Immediately preceding" = the last such field that appears before the password.
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
  for (const input of candidates) {
    if (input === password) break;
    const type = input.getAttribute("type")?.toLowerCase() ?? "";
    if (USERNAME_TYPES.has(type) && isFillable(input)) previous = input;
  }
  return previous;
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

/** Final isolated-world binding check immediately before any DOM write. */
export function performBoundFill(
  doc: Document,
  message: FillRequestMessage,
  currentUrl: string,
  currentDocumentId: string,
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
  const outcome = performFill(doc, message.fields);
  if (!outcome.ok || !message.submit) return outcome;

  const password = firstFillablePassword(doc);
  if (password === null || !submitLoginForm(password)) {
    return { ok: false, reason: "no-form" };
  }
  return { ok: true };
}

/** Submit only the exact form that owns the filled login field. */
export function submitLoginForm(input: HTMLInputElement): boolean {
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
