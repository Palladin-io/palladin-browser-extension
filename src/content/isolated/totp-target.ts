import { isFillable } from './credential-form-analysis';
import { normalizedControlLabels } from './control-labels';
import { autocompleteTokens, hasOneTimeCodeHint } from './form-semantics';
import { isIdentifiedUsername, isVisibleScopeHint, scopeInputs } from './login-controls';
import { composedForm, composedParent, queryOpenElements } from './open-dom';

const OTP_LABEL = /\b(?:authenticator|authentication app|mfa|totp)\b/i;
const ALTERNATIVE = /\b(?:sms|text message|recovery|backup|payment)|\be-?mail\s+(?:(?:verification|security|one.time)\s+)?code\b|\b(?:sent|send|deliver)\b.{0,30}\be-?mail\b/i;

function totpScope(input: HTMLInputElement): Element {
  const form = composedForm(input);
  if (form) return form;
  let scope: Element | null = null;
  for (let parent = composedParent(input); parent && parent !== input.ownerDocument.body; parent = composedParent(parent)) {
    scope = parent;
    if (parent.matches('section, main, [role="dialog"]')) break;
  }
  return scope ?? input.ownerDocument.body;
}

function instructionText(scope: Element): string | null {
  const pending: Node[] = [scope];
  let text = '', visited = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 256) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      text += ` ${node.textContent ?? ''}`;
      if (text.length > 512) return null;
    } else if (node instanceof Element || node instanceof ShadowRoot) {
      if (node instanceof Element && node.matches('a, button, [role="button"], script, style, input, textarea')) continue;
      const children = node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
      pending.push(...[...children].reverse());
    }
  }
  return text;
}

/** Discovers only public structure and labels; it does not read control values. */
export function discoverTotpTargets(doc: Document): HTMLInputElement[][] {
  const inputs = queryOpenElements<HTMLInputElement>(doc, 'input').filter(input =>
    ['text', 'tel', 'number'].includes(input.type) && isFillable(input));
  const targets: HTMLInputElement[][] = [];
  const grouped = new Set<HTMLInputElement>();
  for (const input of inputs) {
    const scope = totpScope(input);
    const text = instructionText(scope);
    if (text === null) continue;
    const labels = normalizedControlLabels(input).join(' ');
    if (ALTERNATIVE.test(`${text} ${labels}`)) continue;
    if (input.maxLength === 1) {
      const parent = input.parentElement;
      if (!parent || grouped.has(input)) continue;
      const siblings = inputs.filter(other => other.parentElement === parent && other.maxLength === 1);
      const sections = new Set(siblings.map(other => autocompleteTokens(other).find(token => token.startsWith('section-')) ?? ''));
      if ((siblings.length === 6 || siblings.length === 8)
        && sections.size === 1
        && siblings.every(other => autocompleteTokens(other).every(token => !token || token === 'one-time-code' || token === 'on' || token === 'off' || token.startsWith('section-')))
        && (OTP_LABEL.test(`${text} ${labels}`) || siblings.every(hasOneTimeCodeHint))) {
        siblings.forEach(other => grouped.add(other));
        targets.push(siblings);
      }
    } else if (hasOneTimeCodeHint(input) || OTP_LABEL.test(labels)) targets.push([input]);
  }
  return targets;
}

export function isCurrentTotpTarget(doc: Document, target: readonly HTMLInputElement[], allowAmbiguous = false): boolean {
  const targets = discoverTotpTargets(doc);
  return (allowAmbiguous || targets.length === 1) && targets.some(candidate => candidate.length === target.length
    && candidate.every((input, index) => input === target[index] && input.isConnected && input.ownerDocument === doc));
}

export interface TotpBinding {
  readonly target: readonly HTMLInputElement[];
  readonly scope: Element;
  readonly url: string;
  readonly initialValues: readonly string[];
  readonly current: () => boolean;
}

/** Capture independent DOM ownership and values before contacting the worker. */
export function bindTotpTarget(doc: Document, target: readonly HTMLInputElement[]): TotpBinding | null {
  if (!target[0]) return null;
  const scope = totpScope(target[0]);
  const url = doc.location.href;
  const owners = target.map(composedForm);
  const chains = target.map(input => {
    const result: Element[] = [];
    for (let node: Element | null = input; node; node = composedParent(node)) result.push(node);
    return result;
  });
  const initialValues = target.map(input => input.value);
  return { target, scope, url, initialValues, current: () => doc.location.href === url && target.every((input, index) => {
    const chain: Element[] = [];
    for (let node: Element | null = input; node; node = composedParent(node)) chain.push(node);
    return input.ownerDocument === doc && input.isConnected && isFillable(input)
      && totpScope(input) === scope && composedForm(input) === owners[index]
      && chain.length === chains[index]!.length && chain.every((element, offset) => element === chains[index]![offset]);
  }) };
}

/** Writes only to the pre-bound target, stopping on synchronous page mutations. */
export function fillTotp(doc: Document, target: readonly HTMLInputElement[], code: string, expiresAt: number,
  username?: string, allowAmbiguous = false, binding = bindTotpTarget(doc, target), operationCurrent: () => boolean = () => true): boolean {
  if (!binding || binding.target !== target || !/^(?:\d{6}|\d{8})$/.test(code)
    || (target.length !== 1 && target.length !== code.length)) return false;
  const values = [...binding.initialValues];
  if (!allowAmbiguous && values.some(value => value !== '')) return false;
  const identityMatches = () => {
    const identities = scopeInputs(binding.scope as HTMLElement).filter(input => isIdentifiedUsername(input) && isVisibleScopeHint(input));
    return identities.length <= 1 && identities.every(input => input.value === '' || (username !== undefined && input.value === username));
  };
  const valid = () => Date.now() < expiresAt && operationCurrent() && binding.current() && identityMatches()
    && isCurrentTotpTarget(doc, target, allowAmbiguous)
    && target.every((input, index) => input.value === values[index]);
  if (!valid()) return false;
  for (let index = 0; index < target.length; index++) {
    if (!valid()) return false;
    const input = target[index]!;
    const value = target.length === 1 ? code : code[index]!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, value);
    values[index] = value;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    if (!valid()) return false;
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    if (!valid()) return false;
  }
  return true;
}
