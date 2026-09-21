import { takeAutomaticFillProvenance, discardAutomaticFillForInputs } from './automatic-fill-provenance';
import { generateNonce, type AgentInjectForm, type AgentInjectStepOutcome } from '@shared/messaging';
import { sameLiveForm } from '@shared/messaging/agent-live';
import { sameSubmitReady, type DeferredFillMessage, type DeferredFillOutcome, type DeferredCommitMessage, type SubmitReady } from '@shared/messaging/agent-deferred';
import { matchesAgentInjectionTarget } from '@shared/security/domain';
import { isFillable, loginTargetFor } from './credential-form-analysis';
import { hasLoginActionLabel, publicActionLabels, isAccountCreationHeadingText, isIdentifiedUsername, isSubscriptionIdentity, isVisibleScopeHint, scopeInputs } from './login-controls';
import { autocompleteTokens } from './form-semantics';
import { actionCaption, composedForm, queryOpenElements } from './open-dom';
import { hasLiveLoginObstacle } from './agent-live-obstacles';
import { isUsableAgentFormControl } from './agent-form-controls';
import { writeControlValue, type AgentInjectDomAccess } from './agent-inject';
import { isAgentManagedControl, markAgentManagedControl, unmarkAgentManagedControl } from './agent-managed-controls';

export interface DeferredField { readonly input: HTMLInputElement; readonly fieldId: 'credential.username' | 'credential.password'; readonly mode: 'write' | 'compare' }
interface BoundStage { form: AgentInjectForm; scope: HTMLElement; fields: readonly DeferredField[]; signature: string; url: string; deadline: number; validate: (() => boolean) | undefined; action: HTMLButtonElement | HTMLInputElement | undefined }
interface PendingField { field: DeferredField; expected: string; before: string; wrote: boolean; marked: boolean }
interface Pending { bound: BoundStage; fields: PendingField[]; expectedDomain: string; expiresAt: number; deadline: number; timer: ReturnType<typeof setTimeout>; ready: SubmitReady; action: HTMLButtonElement | HTMLInputElement | null; actionSignature: string }

/** Explicit credential-stage preparation, never an executable guess at a DIV.
 * Values remain in this document's isolated world until one reauthorized commit.
 */
export class DeferredLiveLogin {
  private bound: BoundStage | null = null;
  private pending: Pending | null = null;
  constructor(private readonly doc: Document, private readonly documentId: string, private readonly url: () => string,
    private readonly top: () => boolean, private readonly dom: AgentInjectDomAccess) {}

  inspect(targetUrl: string): AgentInjectForm | null {
    this.clear();
    if (!this.top() || targetUrl !== this.url() || new URL(targetUrl).protocol !== 'https:') return null;
    const candidates = queryOpenElements<HTMLFormElement>(this.doc, 'form').flatMap(scope => {
      const stage = this.stage(scope);
      if (!stage) return [];
      const hint = queryOpenElements<HTMLElement>(scope, 'button,input[type="submit"],div,p,span').some(node => this.dom.isVisible(node) && hasLoginActionLabel(node));
      if (!hint || this.actions(scope).length > 0) return [];
      return [{ scope, fields: stage }];
    });
    if (candidates.length !== 1) return null;
    const { scope, fields } = candidates[0]!;
    return this.bind(targetUrl, scope, fields);
  }

  /** Adapter for the existing normal-login discovery. It owns classification;
   * this path only freezes its actual nodes and defers the physical click. */
  bindKnown(targetUrl: string, scope: HTMLElement, fields: readonly DeferredField[], action: HTMLButtonElement | HTMLInputElement, validate: () => boolean, remainingMs: number): AgentInjectForm {
    this.clear();
    const form = this.bind(targetUrl, scope, fields, action, validate);
    this.bound!.deadline = Math.min(this.bound!.deadline, performance.now() + Math.max(0, remainingMs));
    return form;
  }
  private bind(targetUrl: string, scope: HTMLElement, fields: readonly DeferredField[], action?: HTMLButtonElement | HTMLInputElement, validate?: () => boolean): AgentInjectForm {
    const snapshot = generateNonce();
    const form: AgentInjectForm = { version: 2, steps: [{ fields: fields.map(field => ({ entryFieldId: field.fieldId,
      control: field.fieldId === 'credential.password' ? 'password' : 'username', selector: `palladin-live:${snapshot}:${generateNonce()}` })),
      submit: { action: 'deferred-native-click', selector: `palladin-live:${snapshot}:${generateNonce()}` } }] };
    this.bound = { form, scope, fields, action, validate, signature: signature(scope, fields), url: targetUrl, deadline: performance.now() + 60_000 };
    return form;
  }

  async fill(message: DeferredFillMessage): Promise<DeferredFillOutcome> {
    const bound = this.bound; this.bound = null;
    const fail = (): DeferredFillOutcome => ({ ok: false, outcome: 'stale-form-map' });
    if (this.pending || !bound || message.form.version !== 2 || !sameLiveForm(bound.form, message.form)
      || message.documentId !== this.documentId || !this.current(bound) || !matchesAgentInjectionTarget(bound.url, message.expectedDomain)) return fail();
    const remaining = Math.min(10_000, message.expiresAt - Date.now(), bound.deadline - performance.now());
    if (remaining <= 0) return fail();
    const fields: PendingField[] = [];
    for (const field of bound.fields) {
      const expected = message.values.find(value => value.entryFieldId === field.fieldId)?.value;
      const compare = field.mode === 'compare' || (message.requireExistingUsername && field.fieldId === 'credential.username');
      if (!expected || (compare && field.input.value !== expected)) return fail();
      fields.push({ field: compare ? { ...field, mode: 'compare' } : field, expected, before: field.input.value, wrote: false, marked: false });
    }
    const differs = fields.some(field => field.before !== '' && field.before !== field.expected);
    if (differs && (!message.automaticFillSessionId || message.requireExistingUsername
      || fields.some(field => field.field.mode !== 'write' || field.field.input.disabled || field.field.input.readOnly)
      || !takeAutomaticFillProvenance(this.doc, this.documentId, bound.url, message.automaticFillSessionId, fields.map(field => field.field.input)))) return fail();
    // Even a matching agent operation consumes this earlier automatic provenance.
    // A later flow must never reuse it after the first agent has acted.
    discardAutomaticFillForInputs(this.doc, fields.map(field => field.field.input));
    const pendingId = message.pendingId;
    const pending: Pending = { bound, fields, expectedDomain: message.expectedDomain,
      expiresAt: Math.min(message.expiresAt, Date.now() + remaining), deadline: performance.now() + remaining,
      ready: { pendingId, currentUrl: bound.url, documentId: this.documentId, submitSelector: `palladin-live:${pendingId}:${generateNonce()}` },
      action: null, actionSignature: '', timer: setTimeout(() => this.cancel(pendingId), remaining) };
    this.pending = pending;
    try {
      for (const field of pending.fields) {
        if (!this.current(bound) || !this.alive(pending)
          || pending.fields.some(current => current.field.input.value !== current.before)) throw new Error('Stale deferred form');
        if (field.field.mode === 'write' && !isAgentManagedControl(field.field.input)) {
          markAgentManagedControl(field.field.input); field.marked = true;
        }
        if (field.field.mode === 'write' && field.before !== field.expected) {
          field.wrote = true; writeControlValue(field.field.input, field.expected, true);
        }
        field.before = field.expected;
      }
      // Let already queued framework input work run before requesting native
      // commit authorization. The final commit itself never awaits page work.
      await new Promise(resolve => setTimeout(resolve, 0));
      const discoveryDeadline = Math.min(pending.deadline, performance.now() + 5_000);
      while (this.pending === pending && performance.now() < discoveryDeadline) {
        if (!this.current(bound) || !this.alive(pending) || !this.sameValues(pending)) break;
        const actions = this.currentActions(bound);
        if (actions.length > 1) break;
        const action = actions[0];
        if (action) {
          if ((bound.action && action !== bound.action) || !safeDestination(this.doc, bound.scope, action, bound.url)) break;
          pending.action = action; pending.actionSignature = actionSignature(action);
          return { ok: true, submitReady: pending.ready };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch { /* Fail closed without exposing values or page errors. */ }
    this.cancel(pendingId); return fail();
  }

  commit(message: DeferredCommitMessage): AgentInjectStepOutcome {
    const pending = this.pending;
    const fail = (): AgentInjectStepOutcome => ({ ok: false, outcome: 'stale-form-map' });
    if (!pending) return fail();
    // Consume even malformed/stale attempts: no physical submit may be retried.
    this.pending = null; clearTimeout(pending.timer);
    try {
      const action = pending.action;
      if (!sameSubmitReady(message.submitReady, pending.ready) || message.expectedDomain !== pending.expectedDomain
        || Date.now() >= message.expiresAt || !this.alive(pending) || !this.current(pending.bound)
        || !this.sameValues(pending) || !action || this.currentActions(pending.bound).length !== 1
        || this.currentActions(pending.bound)[0] !== action || actionSignature(action) !== pending.actionSignature
        || !safeDestination(this.doc, pending.bound.scope, action, pending.bound.url)) { this.cleanup(pending); return fail(); }
      // No await between native deadline/binding validation and this exact click.
      action.click(); for (const field of pending.fields) { field.expected = ''; field.before = ''; } return { ok: true };
    } catch { this.cleanup(pending); return fail(); }
  }

  cancel(pendingId: string): void { if (this.pending?.ready.pendingId === pendingId) { const pending = this.pending; this.pending = null; this.cleanup(pending); } }
  clear(): void { this.bound = null; if (this.pending) this.cancel(this.pending.ready.pendingId); }
  private alive(pending: Pending): boolean { return Date.now() < pending.expiresAt && performance.now() < pending.deadline; }
  private current(bound: BoundStage): boolean {
    if (!this.top() || this.url() !== bound.url || performance.now() >= bound.deadline || !bound.scope.isConnected
      || bound.fields.some(field => !field.input.isConnected) || signature(bound.scope, bound.fields) !== bound.signature) return false;
    if (bound.validate) return bound.validate();
    if (!(bound.scope instanceof HTMLFormElement)) return false;
    const fields = this.stage(bound.scope);
    return fields !== null && fields.length === bound.fields.length && fields.every((field, index) => {
      const previous = bound.fields[index];
      return previous?.input === field.input && previous.fieldId === field.fieldId && previous.mode === field.mode;
    });
  }
  private sameValues(pending: Pending): boolean { return pending.fields.every(field => field.field.input.value === field.expected); }
  private stage(scope: HTMLFormElement): DeferredField[] | null {
    const inputs = scopeInputs(scope);
    // Covered editable fields still belong to this stage. Native action inputs
    // are checked separately and never mistaken for additional credential fields.
    const fields = inputs.filter(input => !['submit', 'button', 'reset', 'image'].includes(input.type) && isFillable(input));
    const input = fields[0];
    if (![1, 2].includes(fields.length) || !input || fields.some(field => !this.dom.isVisible(field) || isSubscriptionIdentity(field))
      || inputs.some(field => autocompleteTokens(field).includes('new-password') || autocompleteTokens(field).includes('one-time-code'))
      || hasLiveLoginObstacle(this.doc, scope, this.dom)) return null;
    const headings = queryOpenElements(scope, 'header,h1,h2,h3,h4,h5,h6,legend').filter(node => isVisibleScopeHint(node));
    if ([...headings, ...cardHeadings(scope).filter(node => isVisibleScopeHint(node))].some(node => {
      const text = (node.textContent ?? '').trim();
      return isAccountCreationHeadingText(text) || /create\s+(?:an?\s+)?account|sign\s*up|zarejestruj|utwórz\s+konto/i.test(text);
    })) return null;
    if (fields.length === 2) {
      const target = fields.map(loginTargetFor).find(candidate => candidate !== null);
      if (!target?.username || !target.password || target.form !== scope
        || !fields.includes(target.username) || !fields.includes(target.password)
        || inputs.filter(field => field.type === 'password').length !== 1
        || inputs.some(field => field !== target.username && isIdentifiedUsername(field))) return null;
      // A disabled native login action is an observed initial state. A DIV hint
      // alone does not authorize preparing a combined credential form.
      const hints = queryOpenElements<HTMLButtonElement | HTMLInputElement>(scope, 'button,input[type="submit"],input[type="button"]')
        .filter(action => composedForm(action) === scope && ['submit', 'button'].includes(action.type)
          && this.dom.isVisible(action) && isVisibleScopeHint(action) && hasLoginActionLabel(action));
      if (hints.length !== 1) return null;
      return [{ input: target.username, fieldId: 'credential.username', mode: 'write' },
        { input: target.password, fieldId: 'credential.password', mode: 'write' }];
    }
    if (input.type === 'password') {
      if (!autocompleteTokens(input).includes('current-password') || inputs.filter(field => field.type === 'password').length !== 1) return null;
      const identities = inputs.filter(isIdentifiedUsername);
      const identity = identities[0] ?? null;
      if (identities.length > 1 || (identity && (!(identity.disabled || identity.readOnly) || !this.dom.isVisible(identity)
        || !isVisibleScopeHint(identity) || isSubscriptionIdentity(identity)))) return null;
      return [...(identity ? [{ input: identity, fieldId: 'credential.username' as const, mode: 'compare' as const }] : []), { input, fieldId: 'credential.password', mode: 'write' }];
    }
    if (!isIdentifiedUsername(input)) return null;
    const hiddenPassword = inputs.some(field => field.type === 'password' && !isFillable(field));
    const loginHeading = headings.some(node => /^(?:sign\s*in|log\s*in|zaloguj(?:\s+się)?)$/i.test((node.textContent ?? '').trim()));
    return hiddenPassword || loginHeading ? [{ input, fieldId: 'credential.username', mode: 'write' }] : null;
  }
  private actions(scope: HTMLElement): (HTMLButtonElement | HTMLInputElement)[] {
    return queryOpenElements<HTMLButtonElement | HTMLInputElement>(this.doc, 'button,input[type="submit"],input[type="button"]')
      .filter(action => (scope instanceof HTMLFormElement ? composedForm(action) === scope : scope.contains(action) && composedForm(action) === null) && ['submit','button'].includes(action.type) && isUsableAgentFormControl(action, this.dom)
        && hasLoginActionLabel(action));
  }
  private currentActions(bound: BoundStage): (HTMLButtonElement | HTMLInputElement)[] {
    // Known actions retain the existing normal discovery's vocabulary and
    // ambiguity/visibility checks through current(), not this narrower hint list.
    return bound.action ? [bound.action] : this.actions(bound.scope);
  }
  private cleanup(pending: Pending): void {
    clearTimeout(pending.timer);
    for (const field of pending.fields) {
      if (field.wrote && field.field.input.isConnected && field.field.input.value === field.expected) writeControlValue(field.field.input, '', false);
      if (field.marked) unmarkAgentManagedControl(field.field.input);
      field.expected = ''; field.before = '';
    }
  }
}
/** Borrow only the immediate sole-form card, never page-wide promotional copy. */
function cardHeadings(scope: HTMLFormElement): Element[] {
  const card = scope.parentElement;
  if (!card || card === scope.ownerDocument.body || card === scope.ownerDocument.documentElement) return [];
  const forms = queryOpenElements(card, 'form');
  if (forms.length !== 1 || forms[0] !== scope
    || queryOpenElements(card, 'input,select,textarea').some(control => composedForm(control) !== scope)) return [];
  return queryOpenElements(card, 'header,h1,h2,h3,h4,h5,h6,legend').filter(heading => !scope.contains(heading)
    && (heading.parentElement === card || heading.parentElement?.parentElement === card));
}
function signature(scope: HTMLElement, fields: readonly DeferredField[]): string {
  return JSON.stringify([scope.getAttribute('action'),scope.getAttribute('method'),scope.getAttribute('target'),scope.ownerDocument.baseURI,
    scope.ownerDocument.querySelector('base[target]')?.getAttribute('target'), ...fields.map(field => [field.fieldId, field.mode,
      ...['id','name','type','autocomplete','pattern','minlength','maxlength','form','required','disabled','readonly','aria-label','aria-labelledby'].map(key => field.input.getAttribute(key))])]);
}
function actionSignature(action: HTMLElement): string { return JSON.stringify([action.tagName, ...['type','form','formaction','formtarget','formmethod','aria-label','aria-labelledby'].map(key => action.getAttribute(key)), publicActionLabels(action),
  action instanceof HTMLInputElement ? action.value : actionCaption(action)]); }
function safeDestination(doc: Document, scope: HTMLElement, action: HTMLButtonElement | HTMLInputElement, url: string): boolean {
  if (!(scope instanceof HTMLFormElement)) return composedForm(action) === null && scope.contains(action);
  const destination = new URL((action.type === 'submit' ? action.getAttribute('formaction') : null) ?? scope.getAttribute('action') ?? url, doc.baseURI);
  const target = (action.type === 'submit' ? action.getAttribute('formtarget') : null) ?? scope.getAttribute('target') ?? doc.querySelector('base[target]')?.getAttribute('target') ?? '_self';
  return destination.origin === new URL(url).origin && !destination.username && !destination.password && ['', '_self'].includes(target);
}
