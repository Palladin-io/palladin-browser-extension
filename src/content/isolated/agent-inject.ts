import {
  type AgentInjectControl,
  type AgentInjectFormField,
  type AgentInjectStepMessage,
  type AgentInjectStepOutcome,
  type AgentInjectTransitionOutcome,
} from "@shared/messaging";
import { isSecurePage, matchesAgentInjectionTarget } from "@shared/security/domain";

type WritableControl = HTMLInputElement | HTMLTextAreaElement;

interface WrittenControl {
  readonly target: WritableControl;
  readonly field: AgentInjectFormField;
}

export interface AgentInjectDomAccess {
  isVisible(element: HTMLElement): boolean;
}

export function createAgentInjectDomAccess(
  doc: Document,
  isTrustedOverlay: (element: Element) => boolean = () => false,
): AgentInjectDomAccess {
  return {
    isVisible(element): boolean {
      const view = doc.defaultView;
      if (view === null || typeof doc.elementFromPoint !== "function") return false;
      if (typeof element.checkVisibility === "function" && !element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      })) return false;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const hits = typeof doc.elementsFromPoint === "function"
        ? doc.elementsFromPoint(centerX, centerY)
        : [doc.elementFromPoint(centerX, centerY)].filter((hit): hit is Element => hit !== null);
      const hit = hits.find((candidate) => !isTrustedOverlay(candidate)) ?? null;
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity || "1") > 0.01
        && style.pointerEvents !== "none"
        && rect.width > 0
        && rect.height > 0
        && centerX >= 0
        && centerY >= 0
        && centerX <= doc.documentElement.clientWidth
        && centerY <= doc.documentElement.clientHeight
        && hit !== null
        && (hit === element || element.contains(hit) || hit.contains(element));
    },
  };
}

/** Execute one already-validated declarative step without guessing any control. */
export function performAgentInjectStep(
  doc: Document,
  message: AgentInjectStepMessage,
  currentDocumentId: string,
  currentUrl: () => string,
  dom: AgentInjectDomAccess = createAgentInjectDomAccess(doc),
): AgentInjectStepOutcome {
  if (message.documentId !== currentDocumentId) {
    return { ok: false, outcome: "stale-form-map" };
  }
  const initialOrigin = checkOrigin(currentUrl(), message.expectedDomain);
  if (initialOrigin !== null) return { ok: false, outcome: initialOrigin };

  const values = new Map(message.values.map((value) => [value.entryFieldId, value.value]));
  const resolvedBySelector = new Map<string, WritableControl>();
  const written: WrittenControl[] = [];

  for (const field of message.step.fields) {
    const selected = resolveField(doc, field, dom);
    if (selected.status !== "ready") {
      return failWithCleanup(
        written,
        selected.status === "missing" && field.control === "password"
          ? "no-password-field"
          : "ambiguous-form",
      );
    }
    const beforeWrite = checkOrigin(currentUrl(), message.expectedDomain);
    if (beforeWrite !== null) return failWithCleanup(written, beforeWrite);
    const value = values.get(field.entryFieldId);
    if (value === undefined) return failWithCleanup(written, "ambiguous-form");
    writeControlValue(selected.target, value, true);
    written.push({ target: selected.target, field });
    resolvedBySelector.set(field.selector, selected.target);
    const afterWrite = checkOrigin(currentUrl(), message.expectedDomain);
    if (afterWrite !== null) return failWithCleanup(written, afterWrite);
  }

  const beforeSubmit = checkOrigin(currentUrl(), message.expectedDomain);
  if (beforeSubmit !== null) return failWithCleanup(written, beforeSubmit);
  const submitted = submitStep(doc, message, resolvedBySelector, dom);
  if (!submitted) return failWithCleanup(written, "no-submit-control");
  const afterSubmit = checkOrigin(currentUrl(), message.expectedDomain);
  if (afterSubmit !== null) return failWithCleanup(written, afterSubmit);
  return { ok: true };
}

/** One value-free transition probe. The worker repeats it across document replacement. */
export function inspectAgentInjectTransition(
  doc: Document,
  selector: string,
  expectedDomain: string,
  currentUrl: () => string,
  dom: AgentInjectDomAccess = createAgentInjectDomAccess(doc),
): AgentInjectTransitionOutcome {
  const origin = checkOrigin(currentUrl(), expectedDomain);
  if (origin !== null) return { status: origin };
  const candidates = query(doc, selector);
  if (candidates === null) return { status: "ambiguous" };
  const inputCandidates = candidates.filter(isWritableControl);
  if (inputCandidates.length > 0) {
    if (inputCandidates.length !== candidates.length) return { status: "ambiguous" };
    const usable = inputCandidates.filter((candidate) => isUsableInput(candidate, dom));
    if (usable.length === 1) return { status: "ready" };
    return { status: usable.length === 0 ? "missing" : "ambiguous" };
  }
  const visible = candidates.filter((candidate): candidate is HTMLElement =>
    candidate instanceof HTMLElement && dom.isVisible(candidate));
  if (visible.length === 1) return { status: "ready" };
  return { status: visible.length === 0 ? "missing" : "ambiguous" };
}

function resolveField(
  doc: Document,
  field: AgentInjectFormField,
  dom: AgentInjectDomAccess,
): { readonly status: "ready"; readonly target: WritableControl }
  | { readonly status: "missing" | "ambiguous" } {
  const selected = query(doc, field.selector);
  if (selected === null) return { status: "ambiguous" };
  const usable = selected.filter(isWritableControl)
    .filter((candidate) => isUsableInput(candidate, dom));
  if (usable.length === 0) return { status: "missing" };
  if (usable.length !== 1) return { status: "ambiguous" };
  const target = usable[0];
  if (target === undefined || !controlMatches(target, field.control)) {
    return { status: "ambiguous" };
  }
  return { status: "ready", target };
}

function submitStep(
  doc: Document,
  message: AgentInjectStepMessage,
  fieldsBySelector: ReadonlyMap<string, WritableControl>,
  dom: AgentInjectDomAccess,
): boolean {
  const submit = message.step.submit;
  if (submit.action === "press-enter") {
    const target = fieldsBySelector.get(submit.selector);
    if (target === undefined || !isUsableInput(target, dom)) return false;
    const view = target.ownerDocument.defaultView;
    if (view === null) return false;
    const down = new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const useDefault = target.dispatchEvent(down);
    if (useDefault && target.form !== null) target.form.requestSubmit();
    target.dispatchEvent(new view.KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    return true;
  }
  const selected = query(doc, submit.selector);
  if (selected === null) return false;
  const usable = selected.filter((element): element is HTMLElement =>
    element instanceof HTMLElement && isEnabled(element) && dom.isVisible(element));
  if (usable.length !== 1) return false;
  const target = usable[0];
  if (target === undefined) return false;
  target.click();
  return true;
}

function failWithCleanup(
  written: readonly WrittenControl[],
  outcome: Exclude<AgentInjectStepOutcome, { readonly ok: true }>["outcome"],
): AgentInjectStepOutcome {
  for (const item of [...written].reverse()) {
    if (item.field.entryFieldId === "credential.username" && item.field.control === "username") {
      continue;
    }
    try {
      writeControlValue(item.target, "", false);
    } catch {
      // The old document/control may already be detached. Nothing is persisted by the extension.
    }
  }
  return { ok: false, outcome };
}

function checkOrigin(
  url: string,
  expectedDomain: string,
): "insecure-origin" | "origin-mismatch" | null {
  if (!isSecurePage(url)) return "insecure-origin";
  return matchesAgentInjectionTarget(url, expectedDomain) ? null : "origin-mismatch";
}

function query(doc: Document, selector: string): Element[] | null {
  try {
    return [...doc.querySelectorAll(selector)];
  } catch {
    return null;
  }
}

function isWritableControl(element: Element): element is WritableControl {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function isUsableInput(input: WritableControl, dom: AgentInjectDomAccess): boolean {
  return !input.disabled
    && !input.readOnly
    && !input.hidden
    && input.getAttribute("aria-hidden") !== "true"
    && (!(input instanceof HTMLInputElement) || input.type !== "hidden")
    && dom.isVisible(input);
}

function isEnabled(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true"
    || element.getAttribute("aria-disabled") === "true") return false;
  if (element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement) return !element.disabled;
  return true;
}

function controlMatches(input: WritableControl, control: AgentInjectControl): boolean {
  if (input instanceof HTMLTextAreaElement) return control === "text";
  const type = (input.type || "text").toLowerCase();
  if (control === "password") return type === "password";
  if (control === "email") return type === "email" || type === "text";
  if (control === "tel" || control === "otp") return type === "tel"
    || type === "text" || type === "number";
  return type === "text" || type === "email" || type === "tel"
    || type === "search" || type === "url";
}

function writeControlValue(control: WritableControl, value: string, emitEvents: boolean): void {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) control.value = value;
  else setter.call(control, value);
  if (!emitEvents) return;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}
