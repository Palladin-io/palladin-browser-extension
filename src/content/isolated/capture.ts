/**
 * Fail-closed new-password form detection in the isolated world.
 *
 * Detection relies only on the standardized `autocomplete` purposes. Generic
 * password inputs are deliberately ignored: a lone password field is normally
 * a login, and guessing from localized labels or page text would create unsafe
 * false positives. The detector never reads an input value.
 */

import {
  CAPTURE_DETECTED_CHANNEL,
  GENERATED_PASSWORD_LENGTH,
  type CaptureDetectedMessage,
  type CaptureFillOutcome,
  type CaptureFillRequestMessage,
  type CaptureFormKind,
} from "@shared/messaging/capture";
import { createAgentInjectDomAccess } from './agent-inject';

interface DetectedForm {
  readonly form: HTMLFormElement;
  readonly kind: CaptureFormKind;
  readonly newPasswordFields: readonly HTMLInputElement[];
}

interface LiveCandidate extends DetectedForm {
  readonly id: string;
}

export type CaptureIdFactory = () => string;

function autocompletePurpose(input: HTMLInputElement): "current" | "new" | null {
  const tokens = (input.getAttribute("autocomplete") ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const current = tokens.includes("current-password");
  const next = tokens.includes("new-password");
  if (current === next) return null;
  return current ? "current" : "new";
}

/** Attribute-only visibility check, deterministic under jsdom. */
function isCandidateField(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly || input.hidden || input.type !== "password") return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const style = input.getAttribute("style") ?? "";
  return !(
    /display\s*:\s*none/i.test(style) ||
    /visibility\s*:\s*hidden/i.test(style) ||
    /opacity\s*:\s*0(?:\D|$)/i.test(style) ||
    /pointer-events\s*:\s*none/i.test(style)
  );
}

function detectForm(form: HTMLFormElement): DetectedForm | null {
  const passwordFields = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  if (passwordFields.length === 0 || passwordFields.length > 3) return null;
  if (passwordFields.some((input) => !isCandidateField(input))) return null;

  const currentPasswordFields: HTMLInputElement[] = [];
  const newPasswordFields: HTMLInputElement[] = [];
  for (const input of passwordFields) {
    const purpose = autocompletePurpose(input);
    // An unclassified password field makes the whole form ambiguous.
    if (purpose === null) return null;
    if (purpose === "current") currentPasswordFields.push(input);
    else newPasswordFields.push(input);
  }

  if (newPasswordFields.length < 1 || newPasswordFields.length > 2) return null;
  if (currentPasswordFields.length === 0) {
    return { form, kind: "registration", newPasswordFields };
  }
  if (currentPasswordFields.length === 1) {
    return { form, kind: "password-change", newPasswordFields };
  }
  return null;
}

function sameFields(
  left: readonly HTMLInputElement[],
  right: readonly HTMLInputElement[],
): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

function secureOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function emitFieldEvents(input: HTMLInputElement): void {
  const view = input.ownerDocument.defaultView;
  const EventConstructor = view?.Event ?? Event;
  input.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  input.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

function setNativeFieldValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const prototype = view?.HTMLInputElement.prototype ?? HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

export class PasswordCaptureController {
  private candidates = new Map<string, LiveCandidate>();
  private pendingGeneration: { candidateId: string; operationId: string } | null = null;
  private isTrustedOverlay: (element: Element) => boolean = () => false;

  authorizeGeneration(candidateId: string, operationId: string): void { this.pendingGeneration = { candidateId, operationId }; }
  cancelGeneration(): void { this.pendingGeneration = null; }
  trustOverlay(isTrustedOverlay: (element: Element) => boolean): void { this.isTrustedOverlay = isTrustedOverlay; }

  constructor(
    private readonly doc: Document,
    private readonly currentUrl: () => string,
    private readonly documentId: string,
    private readonly createId: CaptureIdFactory = () => crypto.randomUUID(),
  ) {}

  candidateFor(input: HTMLInputElement): { id: string; kind: CaptureFormKind } | null {
    const candidate = [...this.candidates.values()].find(item => item.newPasswordFields.includes(input));
    return candidate && candidate.newPasswordFields.every(field => field.value === ''
      && (field.maxLength < 0 || field.maxLength >= GENERATED_PASSWORD_LENGTH)
      && (field.minLength <= 0 || field.minLength <= GENERATED_PASSWORD_LENGTH)
      && field.pattern === '') ? { id: candidate.id, kind: candidate.kind } : null;
  }

  /**
   * Re-scan the document and return only newly observed candidates. Existing
   * live candidates keep their opaque id and are not announced repeatedly.
   */
  scan(): CaptureDetectedMessage[] {
    if (secureOrigin(this.currentUrl()) === null) {
      this.candidates.clear();
      return [];
    }

    const previous = [...this.candidates.values()];
    const next = new Map<string, LiveCandidate>();
    const messages: CaptureDetectedMessage[] = [];

    for (const form of this.doc.querySelectorAll<HTMLFormElement>("form")) {
      const detected = detectForm(form);
      if (detected === null) continue;
      const existing = previous.find(
        (candidate) =>
          candidate.form === form &&
          candidate.kind === detected.kind &&
          sameFields(candidate.newPasswordFields, detected.newPasswordFields),
      );
      const candidate: LiveCandidate = existing ?? { ...detected, id: this.createId() };
      next.set(candidate.id, candidate);
      if (existing === undefined) {
        messages.push({
          channel: CAPTURE_DETECTED_CHANNEL,
          documentId: this.documentId,
          candidateId: candidate.id,
          kind: candidate.kind,
        });
      }
    }

    this.candidates = next;
    return messages;
  }

  /** Fill only the previously classified `new-password` fields. */
  fill(request: CaptureFillRequestMessage): CaptureFillOutcome {
    if (request.operationId !== undefined) {
      const pending = this.pendingGeneration;
      this.pendingGeneration = null;
      if (pending?.candidateId !== request.candidateId || pending.operationId !== request.operationId) {
        return { ok: false, reason: 'stale-candidate' };
      }
    }
    if (request.expectedDocumentId !== this.documentId) {
      return { ok: false, reason: "stale-candidate" };
    }
    const currentOrigin = secureOrigin(this.currentUrl());
    if (currentOrigin === null || currentOrigin !== request.expectedOrigin) {
      return { ok: false, reason: "origin-changed" };
    }
    const candidate = this.candidates.get(request.candidateId);
    if (candidate === undefined) return { ok: false, reason: "stale-candidate" };
    if (!candidate.form.isConnected) {
      this.candidates.delete(candidate.id);
      return { ok: false, reason: "stale-candidate" };
    }

    const current = detectForm(candidate.form);
    if (
      current === null ||
      current.kind !== candidate.kind ||
      !sameFields(current.newPasswordFields, candidate.newPasswordFields)
    ) {
      this.candidates.delete(candidate.id);
      return { ok: false, reason: "stale-candidate" };
    }

    if (current.newPasswordFields.length === 0 || current.newPasswordFields.some(input =>
      input.value !== '' || (input.maxLength >= 0 && request.value.length > input.maxLength)
      || (input.minLength > 0 && request.value.length < input.minLength)
      || input.pattern !== '')) {
      return { ok: false, reason: 'no-form' };
    }
    const written: HTMLInputElement[] = [];
    const visibility = request.operationId === undefined ? null : createAgentInjectDomAccess(this.doc, this.isTrustedOverlay);
    const rollback = (): CaptureFillOutcome => {
      const live = candidate.form.isConnected
        ? [...candidate.form.querySelectorAll<HTMLInputElement>('input[type="password"]')]
        : [];
      const cleared = [...new Set([...written, ...live])].filter(field => field.value === request.value);
      for (const field of cleared) setNativeFieldValue(field, '');
      for (const field of cleared) if (field.isConnected) emitFieldEvents(field);
      return { ok: false, reason: 'no-form' };
    };
    // Stage the whole pair before page event handlers can re-render either field.
    for (const input of current.newPasswordFields) {
      if (!input.isConnected || !isCandidateField(input) || input.value !== ''
        || secureOrigin(this.currentUrl()) !== request.expectedOrigin
        || (visibility !== null && !visibility.isVisible(input))) {
        return rollback();
      }
      setNativeFieldValue(input, request.value);
      written.push(input);
    }
    for (const input of written) {
      if (!input.isConnected || input.value !== request.value) return rollback();
      emitFieldEvents(input);
      const live = candidate.form.isConnected ? detectForm(candidate.form) : null;
      if (live === null || !sameFields(live.newPasswordFields, written)
        || written.some(field => field.value !== request.value || !field.isConnected)) return rollback();
    }
    return { ok: true };
  }
}


export interface CaptureDetectionHandle {
  readonly controller: PasswordCaptureController;
  stop(): void;
}

/** Observe dynamic forms while keeping all page-derived data inside this world. */
export function startPasswordCaptureDetection(
  doc: Document,
  currentUrl: () => string,
  documentId: string,
  send: (message: CaptureDetectedMessage) => void,
  enabled: boolean,
): CaptureDetectionHandle {
  const controller = new PasswordCaptureController(doc, currentUrl, documentId);
  if (!enabled) return { controller, stop() {} };

  let queued = false;
  const scan = (): void => {
    queued = false;
    for (const message of controller.scan()) send(message);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(scan);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc, { childList: true, subtree: true, attributes: true });
  schedule();
  return { controller, stop: () => observer.disconnect() };
}
