/**
 * The fill request contract between the service worker and the isolated-world
 * content script.
 *
 * This is a `chrome.runtime` request/response message addressed to a specific
 * tab (`chrome.tabs.sendMessage`), NOT a bridge Port broadcast — deliberately.
 * A fill carries a decrypted secret; it must reach only the isolated world of
 * the target tab and MUST NEVER be relayed to the page's main world. Keeping it
 * on the direct request channel (which a web page cannot originate or observe)
 * makes that guarantee structural.
 *
 * SECURITY: the worker only ever sends this AFTER clearing every gate (session
 * unlocked, eTLD+1 match re-checked, HTTPS). The content script does not decide
 * whether to fill — it only performs the DOM write for a request it can attribute
 * to our own extension.
 */

export type FillFieldKind = "username" | "password" | "generated";

/** One ready-to-write value. The content script maps `kind` to a detected input. */
export interface FillField {
  readonly kind: FillFieldKind;
  readonly value: string;
}

export const FILL_REQUEST_CHANNEL = "palladin.fill/request" as const;

/** Request envelope sent worker → isolated content script for the active tab. */
export interface FillRequestMessage {
  readonly channel: typeof FILL_REQUEST_CHANNEL;
  readonly fields: readonly FillField[];
}

/** Why a fill could not be performed on the page (value-free). */
export type FillFailureReason = "no-form";

/** The content script's reply: filled, or nothing fillable was found. */
export type FillOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FillFailureReason };

function isFillField(value: unknown): value is FillField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as { kind?: unknown; value?: unknown };
  return (
    (field.kind === "username" || field.kind === "password" || field.kind === "generated") &&
    typeof field.value === "string"
  );
}

export function isFillRequestMessage(value: unknown): value is FillRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { channel?: unknown; fields?: unknown };
  return (
    message.channel === FILL_REQUEST_CHANNEL &&
    Array.isArray(message.fields) &&
    message.fields.every(isFillField)
  );
}

export function isFillOutcome(value: unknown): value is FillOutcome {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value as { ok?: unknown; reason?: unknown };
  if (outcome.ok === true) return true;
  return outcome.ok === false && outcome.reason === "no-form";
}
