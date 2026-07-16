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

import type { FillField, FillOutcome } from "@shared/messaging";

type TextLikeInput = HTMLInputElement;

const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);

/** Attribute-only visibility check (no layout needed, so it is testable in jsdom). */
function isFillable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.hidden || input.type === "hidden") return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const style = input.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
    return false;
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
 * order — scoped to the password's own form when it has one, else the document.
 * "Immediately preceding" = the last such field that appears before the password.
 */
function usernameFieldFor(
  doc: Document,
  password: HTMLInputElement,
): TextLikeInput | null {
  const scope: ParentNode = password.form ?? doc;
  const candidates = scope.querySelectorAll<HTMLInputElement>("input");
  let previous: TextLikeInput | null = null;
  for (const input of candidates) {
    if (input === password) break;
    const type = input.getAttribute("type")?.toLowerCase() ?? "";
    if (USERNAME_TYPES.has(type) && isFillable(input)) previous = input;
  }
  return previous;
}

/** Set a controlled input's value so React/Vue-style frameworks observe the change. */
function setFieldValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
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

  const password = firstFillablePassword(doc);
  if (!password) return { ok: false, reason: "no-form" };

  const username = usernameFieldFor(doc, password);
  for (const field of fields) {
    if (field.kind === "password") setFieldValue(password, field.value);
    else if (field.kind === "username" && username) setFieldValue(username, field.value);
  }
  return { ok: true };
}
