/**
 * Typed capture vocabulary for new-password forms.
 *
 * The page-facing detector reports shape only: candidate id + form kind. It
 * never reads or sends a username, password, label, or other page-controlled
 * value. A generated value can travel in the opposite direction only after an
 * explicit action in the extension popup, through the worker's active-tab and
 * exact-origin gate, directly to the isolated content script.
 *
 * Saving is a second, explicit popup action after a successful fill. The worker
 * revalidates the active tab and exact HTTPS origin again before performing the
 * canonical Protocol 2 create/update transition.
 */

export type CaptureFormKind = "registration" | "password-change";

const MAX_ID_LENGTH = 128;
const MAX_GENERATED_VALUE_LENGTH = 4096;

export const CAPTURE_DETECTED_CHANNEL = "palladin.capture/detected" as const;
export const CAPTURE_FILL_CHANNEL = "palladin.capture/fill" as const;

/** Shape-only observation sent isolated content script -> worker. */
export interface CaptureDetectedMessage {
  readonly channel: typeof CAPTURE_DETECTED_CHANNEL;
  readonly documentId: string;
  readonly candidateId: string;
  readonly kind: CaptureFormKind;
}

export interface CaptureDetectionAck {
  readonly accepted: boolean;
}

/** Generated value sent worker -> the top-frame isolated content script. */
export interface CaptureFillRequestMessage {
  readonly channel: typeof CAPTURE_FILL_CHANNEL;
  readonly expectedDocumentId: string;
  readonly candidateId: string;
  readonly expectedOrigin: string;
  readonly value: string;
}

export type CaptureFillFailureReason = "stale-candidate" | "origin-changed" | "no-form";

export type CaptureFillOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CaptureFillFailureReason };

/** Safe metadata exposed to the extension-owned popup. */
export interface CapturePromptView {
  readonly id: string;
  readonly kind: CaptureFormKind;
  readonly site: string;
}

export type CapturePopupCommand =
  | { readonly type: "capture/prompt/get" }
  | { readonly type: "capture/prompt/dismiss"; readonly promptId: string }
  | {
      readonly type: "capture/prompt/fill-generated";
      readonly promptId: string;
      readonly value: string;
    }
  | {
      readonly type: "capture/prompt/save";
      readonly promptId: string;
      readonly value: string;
    };

export type CaptureGeneratedFillResult =
  | { readonly status: "filled"; readonly saveAvailable: true }
  | { readonly status: "no-form"; readonly saveAvailable: false }
  | {
      readonly status: "blocked";
      readonly reason: "stale-prompt" | "insecure-page" | "origin-changed";
      readonly saveAvailable: false;
    };

export type CaptureSaveResult =
  | { readonly status: "saved"; readonly action: "created" | "updated" }
  | {
      readonly status: "blocked";
      readonly reason:
        | "stale-prompt"
        | "not-filled"
        | "insecure-page"
        | "origin-changed"
        | "ambiguous-target"
        | "grant-refresh-required";
    };

export type CapturePopupErrorCode = "bad-request" | "unavailable";

export type CapturePopupResult =
  | { readonly ok: true; readonly kind: "prompt"; readonly prompt: CapturePromptView | null }
  | { readonly ok: true; readonly kind: "dismissed" }
  | { readonly ok: true; readonly kind: "fill"; readonly fill: CaptureGeneratedFillResult }
  | { readonly ok: true; readonly kind: "save"; readonly save: CaptureSaveResult }
  | { readonly ok: false; readonly code: CapturePopupErrorCode; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= MAX_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isFormKind(value: unknown): value is CaptureFormKind {
  return value === "registration" || value === "password-change";
}

export function isCaptureDetectedMessage(value: unknown): value is CaptureDetectedMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["channel", "documentId", "candidateId", "kind"])) return false;
  return (
    value.channel === CAPTURE_DETECTED_CHANNEL &&
    isOpaqueId(value.documentId) &&
    isOpaqueId(value.candidateId) &&
    isFormKind(value.kind)
  );
}

export function isCaptureFillRequestMessage(value: unknown): value is CaptureFillRequestMessage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["channel", "expectedDocumentId", "candidateId", "expectedOrigin", "value"])
  ) {
    return false;
  }
  return (
    value.channel === CAPTURE_FILL_CHANNEL &&
    isOpaqueId(value.expectedDocumentId) &&
    isOpaqueId(value.candidateId) &&
    typeof value.expectedOrigin === "string" &&
    value.expectedOrigin.length > 0 &&
    value.expectedOrigin.length <= 2048 &&
    typeof value.value === "string" &&
    value.value.length >= 8 &&
    value.value.length <= MAX_GENERATED_VALUE_LENGTH
  );
}

export function isCaptureFillOutcome(value: unknown): value is CaptureFillOutcome {
  if (!isRecord(value)) return false;
  if (value.ok === true) return hasOnlyKeys(value, ["ok"]);
  return (
    value.ok === false &&
    hasOnlyKeys(value, ["ok", "reason"]) &&
    (value.reason === "stale-candidate" ||
      value.reason === "origin-changed" ||
      value.reason === "no-form")
  );
}

export function isCapturePopupCommand(value: unknown): value is CapturePopupCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "capture/prompt/get":
      return hasOnlyKeys(value, ["type"]);
    case "capture/prompt/dismiss":
      return hasOnlyKeys(value, ["type", "promptId"]) && isOpaqueId(value.promptId);
    case "capture/prompt/fill-generated":
    case "capture/prompt/save":
      return (
        hasOnlyKeys(value, ["type", "promptId", "value"]) &&
        isOpaqueId(value.promptId) &&
        typeof value.value === "string" &&
        value.value.length >= 8 &&
        value.value.length <= MAX_GENERATED_VALUE_LENGTH
      );
    default:
      return false;
  }
}
