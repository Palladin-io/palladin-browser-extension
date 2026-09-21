import { isAgentManagedControl } from './agent-managed-controls';
import { composedParent, queryOpenElements } from './open-dom';
import { analyzeCredentialForm } from './credential-form-analysis';
import { normalizedControlLabels, identityLabelPurpose } from './control-labels';
import { scopeInputs, usernameCandidates, isIdentifiedUsername, isUsernameControl, isSubscriptionIdentity,
  isEmailConfirmationControl, isOneTimeCodeControl, isCollapsedClip, credentialScopeFor,
  ACTION_SELECTOR, isCredentialAction, type CredentialScope } from './login-controls';
import {
  CREDENTIAL_CAPTURE_CHANNEL,
  isCredentialSubmission,
  type CredentialSubmission,
  type CredentialCaptureCommand,
  type SubmittedCredential,
} from "@shared/messaging/credential-capture";

const SETTLE_MS = 700;
const SUBMISSION_TTL_MS = 3 * 60_000;

export function isCaptureVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = view.getComputedStyle(current);
    if (isCollapsedClip(style) || style.getPropertyValue("content-visibility") === "hidden" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || style.opacity === "0") return false;
  }
  return true;
}

function purpose(input: HTMLInputElement): string[] {
  return input.autocomplete.toLowerCase().split(/\s+/);
}

const inputs = scopeInputs;

export function readSubmittedCredential(form: CredentialScope, allowMissingUsername = false): CredentialSubmission | null {
  const fields = inputs(form);
  if (fields.some(isAgentManagedControl)) return null;
  const passwords = fields.filter((field) => field.type === "password" && !field.matches(":disabled") && isCaptureVisible(field));
  if (passwords.length < 1 || passwords.length > 3 || passwords.some((field) => field.value.length === 0)) return null;
  const { current, next, stage } = analyzeCredentialForm(form,
    fields.filter(field => !field.matches(':disabled') && isCaptureVisible(field)));
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
    kind = stage === "registration" ? "registration" : "login";
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

  const usernameFields = fields.filter((field) => !field.matches(":disabled") && isCaptureVisible(field)
    && ["text", "email", "tel"].includes(field.type));
  const candidates = usernameCandidates(usernameFields.filter(field => !isSubscriptionIdentity(field)));
  // Only explicit carried identity metadata may expose a disabled/hidden value.
  // Do not read transport tokens or verification-code controls.
  const retained = candidates.length === 0 ? fields.filter(field =>
    ['hidden', 'text', 'email'].includes(field.type) && purpose(field).includes('username')
    && !isOneTimeCodeControl(field) && !isSubscriptionIdentity(field) && !isEmailConfirmationControl(field)) : [];
  const identities = candidates.length ? candidates : retained;
  const username = identities.length === 1 ? identities[0]!.value.trim() : '';
  const emails = usernameFields.filter(field => !isEmailConfirmationControl(field) && !isSubscriptionIdentity(field)
    && !isOneTimeCodeControl(field) && (field.type === 'email' || purpose(field).includes('email')
      || normalizedControlLabels(field).some(label => identityLabelPurpose(label) === 'email')));
  const confirmations = usernameFields.filter(isEmailConfirmationControl);
  if (confirmations.length && (emails.length !== 1 || !emails[0]!.value.trim()
    || confirmations.some(field => field.value.trim() !== emails[0]!.value.trim()))) return null;
  if (!username && kind !== "password-change" && !(allowMissingUsername && identities.length === 0)) return null;
  // Ordinary login discovery prefers a recognized email over weaker nickname
  // metadata. Registration must still expose that distinct identity choice.
  const nicknames = kind === 'registration' ? usernameFields.filter(field =>
    isUsernameControl(field) && !isSubscriptionIdentity(field) && !isEmailConfirmationControl(field)
    && normalizedControlLabels(field).some(label => ['nickname', 'nick name', 'pseudonym', 'pseudonim', 'nick'].includes(label))) : [];
  const nickname = nicknames.length === 1 ? nicknames[0] : undefined;
  const needsChoice = nickname && !usernameFields.some(field => purpose(field).includes('username'))
    && emails.length === 1 && emails[0] !== nickname
    && identities.every(field => field === nickname || field === emails[0])
    && nickname.value.trim().length > 0 && emails[0]!.value.trim() !== nickname.value.trim();
  const credential: CredentialSubmission = needsChoice
    ? { kind, username: '', password, previousPassword, usernameOptions: { email: emails[0]!.value.trim(), nickname: nickname!.value.trim() } }
    : { kind, username, password, previousPassword };
  return isCredentialSubmission(credential) ? credential : null;
}

function readSubmittedIdentifier(form: CredentialScope): string | null {
  const fields = inputs(form);
  if (fields.some(isAgentManagedControl)) return null;
  if (fields.some(field => isCaptureVisible(field) && (field.type === "password" || isOneTimeCodeControl(field)))) return null;
  const candidates = fields.filter((field) => !field.matches(":disabled") && isCaptureVisible(field)
    && ["text", "email", "tel"].includes(field.type)
    && isIdentifiedUsername(field) && !isSubscriptionIdentity(field) && !isEmailConfirmationControl(field));
  const username = candidates.length === 1 ? candidates[0]!.value.trim() : "";
  return username.length > 0 && username.length <= 512 ? username : null;
}

const ERROR_SELECTOR = '[role="alert"], [aria-invalid="true"], .error, .invalid-feedback, [data-error]';
const STATUS_SELECTOR = '[role="status"], [role="alert"], [aria-live="polite"], .success, [data-success]';
const SUCCESS_TEXT = /(?:password\s+(?:(?:has\s+been|was)\s+)?(?:successfully\s+)?(?:changed|updated)|(?:changed|updated)\s+(?:your\s+)?password\s+successfully|hasło\s+(?:(?:zostało|zosta[lł]o\s+pomyślnie|pomyślnie)\s+)?(?:zmienione|zaktualizowane)|(?:zmieniono|zaktualizowano)\s+(?:pomyślnie\s+)?hasło|successfully\s+(?:signed\s+in|logged\s+in|registered)|account\s+(?:successfully\s+)?created|zalogowano\s+pomyślnie|konto\s+(?:zostało\s+)?utworzone)/i;
const NEGATED_SUCCESS = /\b(?:not|cannot|couldn't|failed|unable|nie|błąd|błędne|niepoprawne)\b/i;

export function capturePageHasError(doc: Document): boolean {
  return queryOpenElements(doc, ERROR_SELECTOR).some((element) => isCaptureVisible(element)
    && (element.getAttribute("aria-invalid") === "true"
      || ((element.textContent ?? "").trim().length > 0 && !isSuccess(element))));
}

function isSuccess(element: Element): boolean {
  const text = (element.textContent ?? "").trim();
  return text.length <= 512 && SUCCESS_TEXT.test(text) && !NEGATED_SUCCESS.test(text);
}

function successElements(doc: Document): Element[] {
  return queryOpenElements(doc, STATUS_SELECTOR).filter((element) => isCaptureVisible(element) && isSuccess(element));
}

export function capturePageHasSuccess(doc: Document): boolean { return successElements(doc).length > 0; }

export function capturePageHasPasswordForm(doc: Document): boolean {
  return queryOpenElements(doc, 'input[type="password"]').some(isCaptureVisible);
}

interface PendingSubmission {
  readonly identifierOnly: boolean;
  readonly id: string;
  readonly passwordFields: readonly WeakRef<HTMLInputElement>[];
  readonly submittedAt: number;
  readonly initialSuccessText: ReadonlyMap<Element, string>;
}

export class CredentialSubmissionObserver {
  private pending: PendingSubmission | null = null;
  private observer: MutationObserver | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly observedRoots = new Set<Document | ShadowRoot>();
  private lastCapture: { scope: WeakRef<CredentialScope>; at: number } | null = null;
  private intent: { form: CredentialScope; at: number } | null = null;

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
    this.doc.addEventListener("click", this.onClick, true);
    this.doc.addEventListener("pointerdown", this.onIntent, true);
    this.doc.addEventListener("keydown", this.onIntent, true);
    view.addEventListener("pagehide", this.onPageHide);
    this.observer = new view.MutationObserver(records => {
      // MutationObserver itself retains observed roots. Release detached SPA
      // components without rescanning the entire document on each mutation.
      if (records.some(record => record.removedNodes.length > 0)) this.releaseDetachedRoots();
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof view.Element) this.observeRoots(node);
      }
      this.scheduleOutcome();
    });
    this.observeRoots(this.doc);
  }

  stop(): void {
    this.clearPending();
    this.observer?.disconnect();
    this.observedRoots.clear();
    this.doc.removeEventListener("submit", this.onSubmit, true);
    this.doc.removeEventListener("click", this.onClick, true);
    this.doc.removeEventListener("pointerdown", this.onIntent, true);
    this.doc.removeEventListener("keydown", this.onIntent, true);
    this.intent = null;
    this.lastCapture = null;
    this.doc.defaultView?.removeEventListener("pagehide", this.onPageHide);
  }

  capture(form: CredentialScope): void {
    const view = this.doc.defaultView;
    if (!view || view.location.protocol !== "https:" || view.top !== view) return;
    try {
      if (new URL(form instanceof view.HTMLFormElement ? form.action || view.location.href : view.location.href, view.location.href).origin !== view.location.origin) return;
    } catch { return; }
    // Enter may invoke the browser's default submitter. Do not stage a value
    // for a scope advertising a cross-origin submit override.
    const actions = form instanceof view.HTMLFormElement ? [...form.elements] : queryOpenElements(form, ACTION_SELECTOR);
    if (actions.some(action => !this.sameOriginAction(action))) return;
    const credential = readSubmittedCredential(form, true);
    const username = credential ? null : readSubmittedIdentifier(form);
    if (!credential && !username) return;
    this.observeRoots(form);
    this.clearPending();
    const id = this.createId();
    this.pending = { id, passwordFields: inputs(form).filter((field) => field.type === "password")
      .map((field) => new WeakRef(field)), identifierOnly: credential === null, submittedAt: this.now(),
      initialSuccessText: new Map(successElements(this.doc).map((element) => [element, element.textContent ?? ""])) };
    this.send(credential
      ? { channel: CREDENTIAL_CAPTURE_CHANNEL, type: "submitted", documentId: this.documentId, submissionId: id, credential }
      : { channel: CREDENTIAL_CAPTURE_CHANNEL, type: "identifier", documentId: this.documentId, submissionId: id, username: username! });
    this.expiryTimer = setTimeout(() => this.clearPending(), SUBMISSION_TTL_MS);
    this.scheduleOutcome();
  }

  private readonly onSubmit = (event: Event): void => {
    const Form = this.doc.defaultView?.HTMLFormElement;
    if (!event.isTrusted || !Form || !(event.target instanceof Form)
      || !this.sameOriginAction((event as SubmitEvent).submitter)
      || this.intent?.form !== event.target || this.now() - this.intent.at > 10_000) return;
    this.intent = null;
    this.captureIntent(event.target);
  };

  private eventTarget(event: Event): Element | null {
    const view = this.doc.defaultView;
    const target = event.composedPath()[0];
    return view && target instanceof view.Element ? target : null;
  }

  private sameOriginAction(action: Element | null): boolean {
    const view = this.doc.defaultView;
    if (!view) return false;
    const destination = action?.getAttribute('formaction');
    try { return destination === null || destination === undefined
      || new URL(destination, this.doc.baseURI).origin === view.location.origin; }
    catch { return false; }
  }

  private captureIntent(scope: CredentialScope): void {
    if (this.lastCapture?.scope.deref() === scope && this.now() - this.lastCapture.at < 500) return;
    const previous = this.pending;
    this.capture(scope);
    if (this.pending && this.pending !== previous) this.lastCapture = { scope: new WeakRef(scope), at: this.now() };
  }

  private readonly onClick = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = this.eventTarget(event);
    let action: Element | null = target;
    while (action && !action.matches(ACTION_SELECTOR)) action = composedParent(action);
    if (!action || !isCredentialAction(action) || !this.sameOriginAction(action)) return;
    const scope = credentialScopeFor(action);
    if (scope) this.captureIntent(scope);
  };

  private readonly onIntent = (event: Event): void => {
    const view = this.doc.defaultView;
    const target = this.eventTarget(event);
    if (!event.isTrusted || !view || !target) return;
    const scope = credentialScopeFor(target);
    if (!scope) return;
    this.intent = { form: scope, at: this.now() };
    if (event instanceof view.KeyboardEvent && event.key === 'Enter' && !event.isComposing
      && target instanceof view.HTMLInputElement && isCaptureVisible(target)
      && !target.matches(':disabled') && (target.type === 'password' || isIdentifiedUsername(target))) this.captureIntent(scope);
  };

  private observeRoot(root: Document | ShadowRoot): void {
    this.observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-invalid', 'aria-hidden'] });
  }

  private releaseDetachedRoots(): void {
    const detached = [...this.observedRoots].filter(root => root instanceof ShadowRoot && !root.host.isConnected);
    if (!detached.length) return;
    this.observer?.disconnect();
    detached.forEach(root => this.observedRoots.delete(root));
    for (const root of this.observedRoots) this.observeRoot(root);
  }

  private observeRoots(root: Document | Element | ShadowRoot): void {
    if (!this.observer) return;
    if ((root instanceof Document || root instanceof ShadowRoot) && !this.observedRoots.has(root)) {
      this.observedRoots.add(root);
      this.observeRoot(root);
    }
    if (root instanceof Element && root.shadowRoot) this.observeRoots(root.shadowRoot);
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) this.observeRoots(element.shadowRoot);
  }

  // The worker retains a bounded submission across same-origin top-frame navigation.
  private readonly onPageHide = (): void => this.stop();

  private scheduleOutcome(): void {
    if (!this.pending || this.settleTimer !== null) return;
    this.settleTimer = setTimeout(() => this.inspectOutcome(), SETTLE_MS);
  }

  private inspectOutcome(): void {
    this.settleTimer = null;
    const pending = this.pending;
    if (!pending) return;
    if (this.now() - pending.submittedAt > SUBMISSION_TTL_MS) { this.clearPending(); return; }
    let outcome: Extract<CredentialCaptureCommand, { type: "outcome" }>["outcome"] | null = null;
    if (capturePageHasError(this.doc)) outcome = "rejected";
    else if (pending.identifierOnly) return;
    else if (successElements(this.doc).some((element) =>
      pending.initialSuccessText.get(element) !== (element.textContent ?? ""))) outcome = "success-message";
    else if (pending.passwordFields.every((reference) => {
      const field = reference.deref();
      return !field || !isCaptureVisible(field);
    }) && !capturePageHasPasswordForm(this.doc)) outcome = "form-dismissed";
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
