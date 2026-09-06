import {
  CREDENTIAL_CAPTURE_CHANNEL,
  isSubmittedCredential,
  type CredentialCaptureCommand,
  type SubmittedCredential,
} from "@shared/messaging/credential-capture";

const SETTLE_MS = 700;
const SUBMISSION_TTL_MS = 3 * 60_000;

export function isCaptureVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || style.opacity === "0") return false;
  }
  return true;
}

function purpose(input: HTMLInputElement): string[] {
  return input.autocomplete.toLowerCase().split(/\s+/);
}

function inputs(form: HTMLFormElement): HTMLInputElement[] {
  const Input = form.ownerDocument.defaultView?.HTMLInputElement;
  return Input ? [...form.elements].filter((element): element is HTMLInputElement => element instanceof Input) : [];
}

export function readSubmittedCredential(form: HTMLFormElement): SubmittedCredential | null {
  const fields = inputs(form);
  const passwords = fields.filter((field) => field.type === "password" && !field.disabled && isCaptureVisible(field));
  if (passwords.length < 1 || passwords.length > 3 || passwords.some((field) => field.value.length === 0)) return null;
  const current = passwords.filter((field) => purpose(field).includes("current-password"));
  const next = passwords.filter((field) => purpose(field).includes("new-password"));
  if (current.some((field) => next.includes(field)) || current.length > 1) return null;

  let kind: SubmittedCredential["kind"];
  let password: string;
  let previousPassword: string | null = null;
  if (next.length > 0) {
    if (next.length > 2 || next.some((field) => field.value !== next[0]!.value)
      || next.length + current.length !== passwords.length) return null;
    kind = current.length === 1 ? "password-change" : "registration";
    password = next[0]!.value;
    previousPassword = current[0]?.value ?? null;
  } else if (passwords.length === 1) {
    kind = "login";
    password = passwords[0]!.value;
  } else if (current.length === 0 && passwords.length === 2 && passwords[0]!.value === passwords[1]!.value) {
    kind = "registration";
    password = passwords[0]!.value;
  } else if (passwords.length === 3 && passwords[1]!.value === passwords[2]!.value
    && (current.length === 0 || current[0] === passwords[0])) {
    kind = "password-change";
    password = passwords[1]!.value;
    previousPassword = passwords[0]!.value;
  } else {
    return null;
  }

  const usernameFields = fields.filter((field) => !field.disabled && isCaptureVisible(field)
    && ["text", "email", "tel"].includes(field.type));
  const explicit = usernameFields.filter((field) => purpose(field).includes("username"));
  const emails = usernameFields.filter((field) => field.type === "email" || purpose(field).includes("email"));
  const candidates = explicit.length > 0 ? explicit : emails.length > 0 ? emails : usernameFields;
  const username = candidates.length === 1 ? candidates[0]!.value.trim() : "";
  if (!username && kind !== "password-change") return null;
  const credential = { kind, username, password, previousPassword };
  return isSubmittedCredential(credential) ? credential : null;
}

const ERROR_SELECTOR = '[role="alert"], [aria-invalid="true"], .error, .invalid-feedback, [data-error]';
const STATUS_SELECTOR = '[role="status"], [role="alert"], [aria-live="polite"], .success, [data-success]';
const SUCCESS_TEXT = /(?:password\s+(?:(?:has\s+been|was)\s+)?(?:successfully\s+)?(?:changed|updated)|(?:changed|updated)\s+(?:your\s+)?password\s+successfully|hasło\s+(?:(?:zostało|zosta[lł]o\s+pomyślnie|pomyślnie)\s+)?(?:zmienione|zaktualizowane)|(?:zmieniono|zaktualizowano)\s+(?:pomyślnie\s+)?hasło|successfully\s+(?:signed\s+in|logged\s+in|registered)|account\s+(?:successfully\s+)?created|zalogowano\s+pomyślnie|konto\s+(?:zostało\s+)?utworzone)/i;
const NEGATED_SUCCESS = /\b(?:not|cannot|couldn't|failed|unable|nie|błąd|błędne|niepoprawne)\b/i;

export function capturePageHasError(doc: Document): boolean {
  return [...doc.querySelectorAll(ERROR_SELECTOR)].some((element) => isCaptureVisible(element)
    && (element.getAttribute("aria-invalid") === "true"
      || ((element.textContent ?? "").trim().length > 0 && !isSuccess(element))));
}

function isSuccess(element: Element): boolean {
  const text = (element.textContent ?? "").trim();
  return text.length <= 512 && SUCCESS_TEXT.test(text) && !NEGATED_SUCCESS.test(text);
}

function successElements(doc: Document): Element[] {
  return [...doc.querySelectorAll(STATUS_SELECTOR)].filter((element) => isCaptureVisible(element) && isSuccess(element));
}

export function capturePageHasSuccess(doc: Document): boolean { return successElements(doc).length > 0; }

export function capturePageHasPasswordForm(doc: Document): boolean {
  return [...doc.querySelectorAll('input[type="password"]')].some(isCaptureVisible);
}

interface PendingSubmission {
  readonly id: string;
  readonly form: HTMLFormElement;
  readonly submittedAt: number;
  readonly initialSuccessText: ReadonlyMap<Element, string>;
}

export class CredentialSubmissionObserver {
  private pending: PendingSubmission | null = null;
  private observer: MutationObserver | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private intent: { form: HTMLFormElement; at: number } | null = null;

  constructor(
    private readonly doc: Document,
    private readonly documentId: string,
    private readonly send: (command: CredentialCaptureCommand) => void,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  start(): void {
    const view = this.doc.defaultView;
    if (!view || view.top !== view || view.location.protocol !== "https:") return;
    this.doc.addEventListener("submit", this.onSubmit, true);
    this.doc.addEventListener("pointerdown", this.onIntent, true);
    this.doc.addEventListener("keydown", this.onIntent, true);
    view.addEventListener("pagehide", this.onPageHide);
    this.observer = new view.MutationObserver(() => this.scheduleOutcome());
    this.observer.observe(this.doc, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-invalid", "aria-hidden"] });
  }

  stop(): void {
    this.clearPending();
    this.observer?.disconnect();
    this.doc.removeEventListener("submit", this.onSubmit, true);
    this.doc.removeEventListener("pointerdown", this.onIntent, true);
    this.doc.removeEventListener("keydown", this.onIntent, true);
    this.intent = null;
    this.doc.defaultView?.removeEventListener("pagehide", this.onPageHide);
  }

  capture(form: HTMLFormElement): void {
    const view = this.doc.defaultView;
    if (!view || view.location.protocol !== "https:" || view.top !== view) return;
    try {
      if (new URL(form.action || view.location.href, view.location.href).origin !== view.location.origin) return;
    } catch { return; }
    const credential = readSubmittedCredential(form);
    if (!credential) return;
    this.clearPending();
    const id = this.createId();
    this.pending = { id, form, submittedAt: this.now(),
      initialSuccessText: new Map(successElements(this.doc).map((element) => [element, element.textContent ?? ""])) };
    this.send({ channel: CREDENTIAL_CAPTURE_CHANNEL, type: "submitted", documentId: this.documentId,
      submissionId: id, credential });
    this.expiryTimer = setTimeout(() => this.clearPending(), SUBMISSION_TTL_MS);
    this.scheduleOutcome();
  }

  private readonly onSubmit = (event: Event): void => {
    const Form = this.doc.defaultView?.HTMLFormElement;
    if (!event.isTrusted || !Form || !(event.target instanceof Form)
      || this.intent?.form !== event.target || this.now() - this.intent.at > 10_000) return;
    this.intent = null;
    this.capture(event.target);
  };

  private readonly onIntent = (event: Event): void => {
    const view = this.doc.defaultView;
    if (!event.isTrusted || !view || !(event.target instanceof view.Element)) return;
    const target = event.target;
    const form = target instanceof view.HTMLInputElement || target instanceof view.HTMLButtonElement
      ? target.form : target.closest("form");
    if (form) this.intent = { form, at: this.now() };
  };

  // The worker retains a bounded submission across same-origin top-frame navigation.
  private readonly onPageHide = (): void => this.stop();

  private scheduleOutcome(): void {
    if (!this.pending) return;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.inspectOutcome(), SETTLE_MS);
  }

  private inspectOutcome(): void {
    this.settleTimer = null;
    const pending = this.pending;
    if (!pending) return;
    if (this.now() - pending.submittedAt > SUBMISSION_TTL_MS) { this.clearPending(); return; }
    let outcome: Extract<CredentialCaptureCommand, { type: "outcome" }>["outcome"] | null = null;
    if (capturePageHasError(this.doc)) outcome = "rejected";
    else if (successElements(this.doc).some((element) =>
      pending.initialSuccessText.get(element) !== (element.textContent ?? ""))) outcome = "success-message";
    else if (!isCaptureVisible(pending.form) && !capturePageHasPasswordForm(this.doc)) outcome = "form-dismissed";
    if (outcome === null) return;
    this.send({ channel: CREDENTIAL_CAPTURE_CHANNEL, type: "outcome", documentId: this.documentId,
      submissionId: pending.id, outcome });
    this.clearPending();
  }

  private clearPending(): void {
    this.pending = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.settleTimer = null;
    this.expiryTimer = null;
  }
}
