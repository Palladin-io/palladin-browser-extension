import { generateNonce, type AgentInjectForm, type AgentInjectStepOutcome } from '@shared/messaging';
import { sameLiveForm } from '@shared/messaging/agent-live';
import { sameSubmitReady, type DeferredFillMessage, type DeferredFillOutcome, type DeferredCommitMessage, type SubmitReady } from '@shared/messaging/agent-deferred';
import { matchesAgentInjectionTarget } from '@shared/security/domain';
import { isFillable } from './credential-form-analysis';
import { isAccountCreationHeadingText, isIdentifiedUsername, isSubscriptionIdentity, isVisibleScopeHint, scopeInputs } from './login-controls';
import { autocompleteTokens } from './form-semantics';
import { actionCaption, composedForm, queryOpenElements } from './open-dom';
import { hasLiveLoginObstacle } from './agent-live-obstacles';
import { isUsableAgentFormControl } from './agent-form-controls';
import { writeControlValue, type AgentInjectDomAccess } from './agent-inject';
import { isAgentManagedControl, markAgentManagedControl, unmarkAgentManagedControl } from './agent-managed-controls';

const ACTION = /^(?:log\s*in|sign\s*in|continue|next|submit|zaloguj(?:\s+się)?|dalej|kontynuuj|anmelden|weiter)$/i;
interface BoundIdentifier { form: AgentInjectForm; scope: HTMLFormElement; input: HTMLInputElement; signature: string; url: string; deadline: number }
interface Pending { bound: BoundIdentifier; expected: string; wrote: boolean; marked: boolean; expectedDomain: string; expiresAt: number; deadline: number; timer: ReturnType<typeof setTimeout>; ready: SubmitReady; action: HTMLButtonElement | HTMLInputElement | null; actionSignature: string }

/** Explicit username-only preparation, never an executable guess at a DIV.
 * Values remain in this document's isolated world until one reauthorized commit.
 */
export class DeferredLiveLogin {
  private bound: BoundIdentifier | null = null;
  private pending: Pending | null = null;
  constructor(private readonly doc: Document, private readonly documentId: string, private readonly url: () => string,
    private readonly top: () => boolean, private readonly dom: AgentInjectDomAccess) {}

  inspect(targetUrl: string): AgentInjectForm | null {
    this.clear();
    if (!this.top() || targetUrl !== this.url() || new URL(targetUrl).protocol !== 'https:') return null;
    const candidates = queryOpenElements<HTMLFormElement>(this.doc, 'form').flatMap(scope => {
      const input = this.identifier(scope);
      if (!input) return [];
      const hint = queryOpenElements<HTMLElement>(scope, 'button,input[type="submit"],div,p,span').some(node => this.dom.isVisible(node) && ACTION.test((deferredActionCaption(node) ?? '').trim()));
      if (!hint || this.actions(scope).length > 0) return [];
      return [{ scope, input }];
    });
    if (candidates.length !== 1) return null;
    const { scope, input } = candidates[0]!;
    const snapshot = generateNonce(), fieldRef = `palladin-live:${snapshot}:${generateNonce()}`, scopeRef = `palladin-live:${snapshot}:${generateNonce()}`;
    const form: AgentInjectForm = { version: 2, steps: [{ fields: [{ entryFieldId: 'credential.username', control: 'username', selector: fieldRef }], submit: { action: 'deferred-native-click', selector: scopeRef } }] };
    this.bound = { form, scope, input, signature: signature(scope, input), url: targetUrl, deadline: performance.now() + 60_000 };
    return form;
  }

  async fill(message: DeferredFillMessage): Promise<DeferredFillOutcome> {
    const bound = this.bound; this.bound = null;
    const fail = (): DeferredFillOutcome => ({ ok: false, outcome: 'stale-form-map' });
    if (this.pending || !bound || message.form.version !== 2 || !sameLiveForm(bound.form, message.form)
      || message.documentId !== this.documentId || !this.current(bound) || !matchesAgentInjectionTarget(bound.url, message.expectedDomain)) return fail();
    const remaining = Math.min(10_000, message.expiresAt - Date.now(), bound.deadline - performance.now());
    const value = message.values[0]?.value;
    if (remaining <= 0 || !value || (bound.input.value !== '' && bound.input.value !== value)) return fail();
    const pendingId = message.pendingId;
    const pending: Pending = { bound, expected: value, wrote: bound.input.value === '', marked: !isAgentManagedControl(bound.input),
      expectedDomain: message.expectedDomain, expiresAt: Math.min(message.expiresAt, Date.now() + remaining), deadline: performance.now() + remaining,
      ready: { pendingId, currentUrl: bound.url, documentId: this.documentId, submitSelector: `palladin-live:${pendingId}:${generateNonce()}` },
      action: null, actionSignature: '', timer: setTimeout(() => this.cancel(pendingId), remaining) };
    this.pending = pending;
    if (pending.marked) markAgentManagedControl(bound.input);
    try {
      if (pending.wrote) writeControlValue(bound.input, value, true);
      const discoveryDeadline = Math.min(pending.deadline, performance.now() + 5_000);
      while (this.pending === pending && performance.now() < discoveryDeadline) {
        if (!this.current(bound) || !this.alive(pending) || bound.input.value !== pending.expected) break;
        const actions = this.actions(bound.scope);
        if (actions.length > 1) break;
        const action = actions[0];
        if (action) {
          if (!safeDestination(this.doc, bound.scope, action, bound.url)) break;
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
        || pending.bound.input.value !== pending.expected || !action || this.actions(pending.bound.scope).length !== 1
        || this.actions(pending.bound.scope)[0] !== action || actionSignature(action) !== pending.actionSignature
        || !safeDestination(this.doc, pending.bound.scope, action, pending.bound.url)) { this.cleanup(pending); return fail(); }
      // No await between native deadline/binding validation and this exact click.
      action.click(); pending.expected = ''; return { ok: true };
    } catch { this.cleanup(pending); return fail(); }
  }

  cancel(pendingId: string): void { if (this.pending?.ready.pendingId === pendingId) { const pending = this.pending; this.pending = null; this.cleanup(pending); } }
  clear(): void { this.bound = null; if (this.pending) this.cancel(this.pending.ready.pendingId); }
  private alive(pending: Pending): boolean { return Date.now() < pending.expiresAt && performance.now() < pending.deadline; }
  private current(bound: BoundIdentifier): boolean {
    return this.top() && this.url() === bound.url && performance.now() < bound.deadline && bound.scope.isConnected && bound.input.isConnected
      && composedForm(bound.input) === bound.scope && signature(bound.scope, bound.input) === bound.signature
      && this.identifier(bound.scope) === bound.input;
  }
  private identifier(scope: HTMLFormElement): HTMLInputElement | null {
    const inputs = scopeInputs(scope);
    // Covered editable fields still belong to this stage. Native action inputs
    // are checked separately and never mistaken for additional credential fields.
    const fields = inputs.filter(input => !['submit', 'button', 'reset', 'image'].includes(input.type) && isFillable(input));
    const input = fields[0];
    if (fields.length !== 1 || !input || !this.dom.isVisible(input) || !isIdentifiedUsername(input) || isSubscriptionIdentity(input)
      || inputs.some(field => autocompleteTokens(field).includes('new-password') || autocompleteTokens(field).includes('one-time-code'))
      || hasLiveLoginObstacle(this.doc, scope, this.dom)) return null;
    const headings = queryOpenElements(scope, 'header,h1,h2,h3,h4,h5,h6,legend').filter(node => isVisibleScopeHint(node));
    if ([...headings, ...cardHeadings(scope).filter(node => isVisibleScopeHint(node))].some(node => {
      const text = (node.textContent ?? '').trim();
      return isAccountCreationHeadingText(text) || /create\s+(?:an?\s+)?account|sign\s*up|zarejestruj|utwórz\s+konto/i.test(text);
    })) return null;
    const hiddenPassword = inputs.some(field => field.type === 'password' && !isFillable(field));
    const loginHeading = headings.some(node => /^(?:sign\s*in|log\s*in|zaloguj(?:\s+się)?)$/i.test((node.textContent ?? '').trim()));
    return hiddenPassword || loginHeading ? input : null;
  }
  private actions(scope: HTMLFormElement): (HTMLButtonElement | HTMLInputElement)[] {
    return queryOpenElements<HTMLButtonElement | HTMLInputElement>(this.doc, 'button,input[type="submit"],input[type="button"]')
      .filter(action => composedForm(action) === scope && ['submit','button'].includes(action.type) && isUsableAgentFormControl(action, this.dom)
        && ACTION.test((deferredActionCaption(action) ?? '').trim()));
  }
  private cleanup(pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.wrote && pending.bound.input.isConnected && pending.bound.input.value === pending.expected) writeControlValue(pending.bound.input, '', false);
    if (pending.marked) unmarkAgentManagedControl(pending.bound.input);
    pending.expected = '';
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
function signature(scope: HTMLFormElement, input: HTMLInputElement): string {
  return JSON.stringify([scope.getAttribute('action'),scope.getAttribute('method'),scope.getAttribute('target'),scope.ownerDocument.baseURI,
    scope.ownerDocument.querySelector('base[target]')?.getAttribute('target'), ...['id','name','type','autocomplete','pattern','minlength','maxlength','form','required','aria-label','aria-labelledby'].map(key => input.getAttribute(key))]);
}
function deferredActionCaption(element: HTMLElement): string | null {
  return element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type) ? element.value : actionCaption(element);
}
function actionSignature(action: HTMLElement): string { return JSON.stringify([action.tagName, ...['type','form','formaction','formtarget','formmethod'].map(key => action.getAttribute(key)), deferredActionCaption(action)]); }
function safeDestination(doc: Document, scope: HTMLFormElement, action: HTMLButtonElement | HTMLInputElement, url: string): boolean {
  const destination = new URL((action.type === 'submit' ? action.getAttribute('formaction') : null) ?? scope.getAttribute('action') ?? url, doc.baseURI);
  const target = (action.type === 'submit' ? action.getAttribute('formtarget') : null) ?? scope.getAttribute('target') ?? doc.querySelector('base[target]')?.getAttribute('target') ?? '_self';
  return destination.origin === new URL(url).origin && !destination.username && !destination.password && ['', '_self'].includes(target);
}
