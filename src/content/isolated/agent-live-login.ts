import { DeferredLiveLogin, type DeferredField } from './agent-live-deferred';
import type { DeferredFillMessage, DeferredCommitMessage } from '@shared/messaging/agent-deferred';
import { sameLiveStep, type LiveLoginProbe } from '@shared/messaging/agent-live';
/** Experimental login discovery. Plans contain expiring isolated-world handles,
 * never persistent site selectors; map execution remains a separate path. */
import { type AgentInjectForm, type AgentInjectFormField, type AgentInjectStepMessage, type AgentInjectStepOutcome } from '@shared/messaging';
import { AGENT_FORM_INSPECT_CHANNEL, AGENT_FORM_LIMITS } from '@shared/messaging/agent-form';
import { AgentFormRegistry } from './agent-form';
import { performAgentInjectStep, type AgentInjectDomAccess } from './agent-inject';
import { loginTargetFor, isFillable } from './credential-form-analysis';
import { credentialScopeFor, isEmailConfirmationControl, isIdentifiedUsername, isOneTimeCodeControl, isSubscriptionIdentity, isVisibleScopeHint, scopeInputs } from './login-controls';
import { actionCaption, composedForm } from './open-dom';
import { markAgentManagedControl, isAgentManagedControl, unmarkAgentManagedControl } from './agent-managed-controls';
import { hasLiveLoginObstacle } from './agent-live-obstacles';

export const LIVE_SELECTOR_PREFIX = 'palladin-live:';
const ACTION = /^(?:log\s*in|sign\s*in|continue|next|submit|verify|verify code|authenticate|zaloguj(?:\s+się)?|dalej|kontynuuj|potwierdź|zweryfikuj|anmelden|weiter)$/i;
export class LiveLogin {
  private readonly registry: AgentFormRegistry;
  private readonly deferred: DeferredLiveLogin;
  private plan: AgentInjectForm | null = null;
  private targetUrl = '';
  private expiresAt = 0;
  private inspectionOutcome: 'no-form' | 'challenge' = 'no-form';
  private bindings: { selector: string; element: HTMLElement; signature: string; owner: HTMLFormElement | null }[] = [];
  constructor(private readonly doc: Document, private readonly documentId: string,
    private readonly url: () => string, private readonly top: () => boolean, private readonly dom: AgentInjectDomAccess) {
    this.registry = new AgentFormRegistry(doc, documentId, url, top, dom);
    this.deferred = new DeferredLiveLogin(doc, documentId, url, top, dom);
  }
  inspect(targetUrl: string): AgentInjectForm | null {
    const normal = this.inspectCurrent(targetUrl);
    if (!normal) return this.inspectionOutcome === 'challenge' ? null : this.deferred.inspect(targetUrl);
    if (normal.steps[0]!.fields.some(field => field.entryFieldId === 'credential.totp')) return normal;
    const bindings = [...this.bindings];
    const fields: DeferredField[] = normal.steps[0]!.fields.map(field => ({
      input: bindings.find(binding => binding.selector === field.selector)!.element as HTMLInputElement,
      fieldId: field.entryFieldId as DeferredField['fieldId'], mode: 'write',
    }));
    const scope = credentialScopeFor(fields[0]!.input);
    const action = bindings.find(binding => binding.selector === normal.steps[0]!.submit.selector)?.element;
    if (!scope || !(action instanceof HTMLButtonElement || action instanceof HTMLInputElement)) return null;
    const carriedIdentities = () => scopeInputs(scope).filter(input => isIdentifiedUsername(input)
      && !isSubscriptionIdentity(input) && !isEmailConfirmationControl(input) && (input.disabled || input.readOnly));
    const identities = carriedIdentities();
    const identity = identities[0];
    if (identities.length > 1 || (identity && (fields.some(field => field.fieldId === 'credential.username')
      || !this.dom.isVisible(identity) || !isVisibleScopeHint(identity)))) return null;
    if (identity) fields.unshift({ input: identity, fieldId: 'credential.username', mode: 'compare' });
    const currentIdentity = () => {
      const current = carriedIdentities();
      return current.length === identities.length && current.every((input, index) => input === identities[index]
        && credentialScopeFor(input) === scope && this.dom.isVisible(input) && isVisibleScopeHint(input));
    };
    const expiresAt = this.expiresAt;
    return this.deferred.bindKnown(targetUrl, scope, fields, action,
      () => Date.now() < expiresAt && currentIdentity() && this.matchesBindings(targetUrl, normal, bindings), expiresAt - Date.now());
  }
  fillDeferred(message: DeferredFillMessage) { return this.deferred.fill(message); }
  commitDeferred(message: DeferredCommitMessage) { return this.deferred.commit(message); }
  cancelDeferred(pendingId: string) { this.deferred.cancel(pendingId); }
  /** Existing immediate discovery core, also used to revalidate deferred nodes. */
  inspectCurrent(targetUrl: string): AgentInjectForm | null {
    this.clear();
    this.inspectionOutcome = 'no-form';
    const inspected = this.registry.inspect({ channel: AGENT_FORM_INSPECT_CHANNEL, documentId: this.documentId, targetUrl });
    if (inspected.outcome !== 'ready') {
      // A CAPTCHA-only or framed screen may contain no supported controls at all.
      if (inspected.outcome === 'form-too-large' || (inspected.outcome === 'no-controls'
        && [...this.doc.querySelectorAll<HTMLElement>('iframe, [data-sitekey], [id*="captcha" i], [class*="captcha" i], [contenteditable="true"], [role="textbox"], [role="combobox"]')]
          .some(element => this.dom.isVisible(element)))) this.inspectionOutcome = 'challenge';
      this.clear(); return null;
    }
    const snapshot = inspected.snapshot;
    const nodes = snapshot.controls.map(control => ({ control, element: this.registry.resolve(snapshot.snapshotId, control.ref) }));
    const inputs = nodes.flatMap(({ element }) => element instanceof HTMLInputElement ? [element] : []);
    const targets = inputs.map(loginTargetFor).filter(target => target !== null);
    let fields: { input: HTMLInputElement; fieldId: string; control: AgentInjectFormField['control'] }[];
    let scope: HTMLElement | null;
    if (targets.length === 1) {
      const target = targets[0]!;
      scope = target.form;
      fields = [];
      if (target.username) fields.push({ input: target.username, fieldId: 'credential.username', control: 'username' });
      if (target.password) fields.push({ input: target.password, fieldId: 'credential.password', control: 'password' });
    } else {
      const otp = inputs.filter(isOneTimeCodeControl);
      if (targets.length || otp.length !== 1) { this.clear(); return null; }
      scope = credentialScopeFor(otp[0]!);
      // SMS/email delivery, recovery codes and approval prompts are not TOTP.
      const text = scope?.textContent ?? '';
      if (!/authenticator|authentication app|\bMFA\b|\bTOTP\b|aplikacj.{0,20}uwierzyteln/i.test(text)
        || /\bsms|text message|sent (?:a |the )?code|recovery code|backup code|kod.{0,20}(?:sms|e-mail)/i.test(text)) { this.inspectionOutcome = 'challenge'; this.clear(); return null; }
      fields = [{ input: otp[0]!, fieldId: 'credential.totp', control: 'otp' }];
    }
    if (!scope || scopeInputs(scope).filter(isFillable).some(input =>
      !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(input.type)
      && !fields.some(field => field.input === input))) { this.clear(); return null; }
    if (hasLiveLoginObstacle(this.doc, scope, this.dom)) {
      this.inspectionOutcome = 'challenge'; this.clear(); return null;
    }
    const actions = nodes.filter(({ element }) => element instanceof HTMLElement
      && credentialScopeFor(element) === scope && ACTION.test((actionCaption(element) ?? '').trim())
      && ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && ['submit', 'button'].includes(element.type)));
    if (actions.length !== 1) { this.clear(); return null; }
    const ref = (reference: string) => `${LIVE_SELECTOR_PREFIX}${snapshot.snapshotId}:${reference}`;
    const planned: AgentInjectFormField[] = [];
    for (const field of fields) {
      const node = nodes.find(item => item.element === field.input);
      if (!node) { this.clear(); return null; }
      planned.push({ entryFieldId: field.fieldId, control: field.control, selector: ref(node.control.ref) });
    }
    this.bindings = [...planned.map(field => field.selector), ref(actions[0]!.control.ref)].map(selector => {
      const node = nodes.find(item => ref(item.control.ref) === selector)!;
      const element = node.element as HTMLInputElement | HTMLButtonElement;
      return { selector, element, signature: liveControlSignature(element), owner: composedForm(element) };
    });
    // Live login re-discovers and compares the actual bound controls before each
    // operation. A document-wide dirty bit rejects normal framework input updates.
    // Registration snapshots keep their existing strict mutation policy.
    this.registry.clear();
    this.expiresAt = Date.now() + AGENT_FORM_LIMITS.lifetimeMs;
    this.targetUrl = targetUrl;
    this.plan = { version: 1, steps: [{ fields: planned, submit: { action: 'click', selector: ref(actions[0]!.control.ref) } }] };
    return this.plan;
  }
  probe(targetUrl: string): LiveLoginProbe {
    const form = this.inspect(targetUrl);
    return form ? { outcome: 'ready', form } : { outcome: this.inspectionOutcome };
  }
  fill(message: AgentInjectStepMessage): AgentInjectStepOutcome {
    const fail = (): AgentInjectStepOutcome => ({ ok: false, outcome: 'stale-form-map' });
    const newlyManaged: HTMLInputElement[] = [];
    let completed = false;
    try {
      if (!this.top() || this.url() !== this.targetUrl || message.documentId !== this.documentId
        || !this.plan || !sameLiveStep(message.step, this.plan.steps[0]!)) return fail();
      const initialValues = new Map<HTMLInputElement, string>();
      const expectedValues = new Map<HTMLInputElement, string>();
      let executing = false;
      const resolve = (selector: string): HTMLElement | null => {
        if (!this.hasCurrentBindings()) return null;
        const element = this.bindings.find(binding => binding.selector === selector)?.element ?? null;
        if (executing && selector === message.step.submit.selector
          && [...expectedValues].some(([input, value]) => input.value !== value)) return null;
        if (element instanceof HTMLInputElement && initialValues.has(element)
          && element.value !== initialValues.get(element)) return null;
        return element;
      };
      for (const field of message.step.fields) {
        const input = resolve(field.selector);
        const value = message.values.find(item => item.entryFieldId === field.entryFieldId)?.value;
        if (!(input instanceof HTMLInputElement) || value === undefined
          || (message.requireExistingUsername && field.entryFieldId === 'credential.username' && input.value !== value)
          || (input.value !== '' && input.value !== value)) return fail();
        initialValues.set(input, input.value);
        expectedValues.set(input, value);
      }
      const action = resolve(message.step.submit.selector);
      if (!(action instanceof HTMLButtonElement || action instanceof HTMLInputElement)) return fail();
      const owner = composedForm(action);
      if (owner) {
        // A plain button may submit its owner through a page handler. Its
        // submitter-only overrides are inert and cannot mask that destination.
        const destination = new URL((action.type === 'submit' ? action.getAttribute('formaction') : null)
          ?? owner.getAttribute('action') ?? this.targetUrl, this.doc.baseURI);
        const target = (action.type === 'submit' ? action.getAttribute('formtarget') : null)
          ?? owner.getAttribute('target') ?? this.doc.querySelector('base[target]')?.getAttribute('target') ?? '_self';
        if (destination.origin !== new URL(this.targetUrl).origin || destination.username || destination.password
          || !['', '_self'].includes(target)) return fail();
      }
      for (const input of initialValues.keys()) {
        if (!isAgentManagedControl(input)) { newlyManaged.push(input); markAgentManagedControl(input); }
      }
      executing = true;
      const outcome = performAgentInjectStep(this.doc, message, this.documentId, this.url, { ...this.dom, preserveMatchingValues: true, resolveLiveControl: resolve });
      completed = outcome.ok;
      return outcome;
    } finally {
      if (!completed) for (const input of newlyManaged) unmarkAgentManagedControl(input);
      this.clear();
    }
  }
  private hasCurrentBindings(): boolean {
    if (!this.plan || Date.now() >= this.expiresAt) return false;
    return this.matchesBindings(this.targetUrl, this.plan, this.bindings);
  }
  private matchesBindings(targetUrl: string, plan: AgentInjectForm, bindings: typeof this.bindings): boolean {
    const current = new LiveLogin(this.doc, this.documentId, this.url, this.top, this.dom);
    try {
      const form = current.inspectCurrent(targetUrl);
      if (!form || current.bindings.length !== bindings.length) return false;
      const fields = plan.steps[0]!.fields;
      const currentFields = form.steps[0]!.fields;
      return fields.length === currentFields.length
        && fields.every((field, index) => field.entryFieldId === currentFields[index]?.entryFieldId
          && field.control === currentFields[index]?.control)
        && bindings.every((binding, index) => {
          const latest = current.bindings[index];
          return latest?.element === binding.element && latest.owner === binding.owner
            && latest.signature === binding.signature;
        });
    } finally { current.clear(); }
  }
  clear(): void {
    this.deferred.clear();
    this.registry.clear(); this.plan = null; this.targetUrl = '';
    this.bindings = []; this.expiresAt = 0;
  }
}

/** No values: input/change may reflect a controlled input into its value attribute.
 * Identity, meaning, constraints and submission destination must still match. */
function liveControlSignature(element: HTMLInputElement | HTMLButtonElement): string {
  const owner = composedForm(element);
  return JSON.stringify([
    element.tagName,
    ...['id', 'type', 'name', 'autocomplete', 'pattern', 'minlength', 'maxlength',
      'required', 'form', 'formaction', 'formtarget', 'formmethod', 'aria-label',
      'aria-labelledby'].map(attribute => element.getAttribute(attribute)),
    owner?.getAttribute('action'), owner?.getAttribute('target'),
    owner?.getAttribute('method'),
    element.ownerDocument.baseURI,
    element.ownerDocument.querySelector('base[target]')?.getAttribute('target'),
    element instanceof HTMLButtonElement ? actionCaption(element) : null,
  ]);
}
