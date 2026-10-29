import type { SecretCandidate } from '../../shared/messaging/secret-capture';

const API = /api[\s_-]*(?:key|token)|secret[\s_-]*key|access[\s_-]*token/i;
const KEY_ID = /(?:key|access)[\s_-]*(?:id|identifier)\b/i;
const EXCLUDED = /password|passwd|csrf|xsrf|session|one[\s_-]*time|otp|pin\b|example|sample|documentation|placeholder/i;
const GENERATED = /generated|created|new key|new token/i;

function luhn(value: string): boolean {
  if (!/^\d{12,19}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  let sum = 0;
  for (let i = value.length - 1, alternate = false; i >= 0; i--, alternate = !alternate) {
    let digit = Number(value[i]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export interface SecretDetectionOptions {
  scope?: Element;
  cardScopeId?(group: Element): string;
  /** Isolated-runtime signal following a trusted user action and observed local
   * result update. Requires a narrow, connected result scope. Never derive this
   * from a page message/attribute or set it for an initial/global mutation scan.
   * It admits recognized provider formats in readonly/output/text results without
   * English copy; all visibility, size and exclusion checks still apply. */
  trustedGeneratedResult?: boolean;
}

/** Debounce mutation snapshots. After trusted input/blur pass the enclosing form
 * or section, so card grouping retains siblings. Never combines documents. */
export function detectSecretCandidates(doc: Document, options: SecretDetectionOptions = {}): SecretCandidate[] {
  if (options.scope && (options.scope.ownerDocument !== doc || !options.scope.isConnected)) return [];
  let work = 20000;
  const composedParent = (element: Element): Element | null => {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const visibility = new Map<Element, boolean>();
  const visible = (element: Element): boolean => {
    const chain: Element[] = [];
    let current: Element | null = element;
    let result = true;
    while (current) {
      if (visibility.has(current)) {
        result = visibility.get(current)!;
        break;
      }
      if (--work < 0 || chain.length >= 128 || !current.isConnected || current.hasAttribute('hidden')
        || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') {
        result = false;
        break;
      }
      chain.push(current);
      const style = doc.defaultView?.getComputedStyle(current);
      if (!style || style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || style.opacity === '0') {
        result = false;
        break;
      }
      current = composedParent(current);
    }
    for (const item of chain) visibility.set(item, result);
    return result;
  };
  const renderedChildren = (node: Node): ArrayLike<Node> => {
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes();
      return assigned.length ? assigned : node.childNodes;
    }
    return node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
  };
  const text = (element: Element, limit = 1024): string => {
    const pending: Node[] = [element];
    let result = '';
    for (let count = 0; pending.length && count < 64 && --work >= 0; count++) {
      const node = pending.pop()!;
      if (node instanceof Element && !visible(node)) continue;
      if (node.nodeType === 3) {
        result += node.nodeValue?.slice(0, limit - result.length) ?? '';
        if (result.length >= limit) break;
      } else {
        const children = renderedChildren(node);
        for (let i = Math.min(children.length, 64 - pending.length) - 1; i >= 0; i--) {
          pending.push(children[i]!);
        }
      }
    }
    return result;
  };
  const hints = new Map<Element, string>();
  const hint = (element: Element): string => {
    if (hints.has(element)) return hints.get(element)!;
    const attributes = ['id', 'name', 'aria-label', 'placeholder', 'autocomplete'];
    const parts = attributes.map(key => (element.getAttribute(key) ?? '').slice(0, 256));
    if (element instanceof HTMLInputElement) {
      const labels = element.labels;
      for (let i = 0; labels && i < Math.min(labels.length, 4); i++) parts.push(text(labels[i]!, 512));
    }
    const result = parts.join(' ');
    hints.set(element, result);
    return result;
  };
  const localGroups = new Map<Element, Element | null>();
  const localGroup = (element: HTMLElement): Element | null => {
    if (localGroups.has(element)) return localGroups.get(element)!;
    let group: Element | null = null;
    if ((element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.form) {
      group = element.form;
    } else {
      let current: Element | null = element;
      for (let depth = 0; current && depth < 128 && --work >= 0; depth++) {
        if (current.matches('fieldset,section,[role="group"],form')) {
          group = current;
          break;
        }
        current = composedParent(current);
      }
    }
    localGroups.set(element, group);
    return group;
  };
  const context = (element: HTMLElement): string => {
    const group = localGroup(element);
    const parts = [hint(element)];
    let current = composedParent(element);
    for (let depth = 0; current && depth < 5 && --work >= 0; depth++) {
      if (current === doc.body || current === doc.documentElement) break;
      parts.push(text(current));
      if (current === group) break;
      current = composedParent(current);
    }
    return parts.join(' ');
  };
  const elements: HTMLElement[] = [];
  const pending: Element[] = options.scope ? [options.scope] : doc.documentElement ? [doc.documentElement] : [];
  if (options.scope instanceof HTMLFormElement) {
    // HTML form ownership includes external controls, but never unrelated sibling metadata.
    const controls = options.scope.elements;
    for (let i = 0; i < controls.length && i < 2000 && pending.length < 2000 && --work >= 0; i++) {
      const control = controls[i];
      if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)
        && control.form === options.scope && !options.scope.contains(control)) pending.push(control);
    }
  }
  const visited = new Set<Element>();
  while (pending.length && visited.size < 2000 && --work >= 0) {
    const element = pending.pop()!;
    if (visited.has(element)) continue;
    visited.add(element);
    if (element instanceof HTMLElement) elements.push(element);
    const children = renderedChildren(element);
    for (let i = Math.min(children.length, 2000 - pending.length) - 1; i >= 0; i--) {
      const child = children[i]!;
      if (child instanceof Element) pending.push(child);
    }
  }
  const laidOut = (element: HTMLElement): boolean => visible(element)
    && Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  const fields = elements.filter((element): element is HTMLInputElement | HTMLSelectElement =>
    (element instanceof HTMLInputElement || element instanceof HTMLSelectElement)
    && !element.disabled
    && !['hidden', 'password', 'checkbox', 'radio', 'submit', 'button'].includes(element.type)
    && laidOut(element)
    && !EXCLUDED.test(hint(element)));
  const output: SecretCandidate[] = [];
  const add = (candidate: SecretCandidate): void => {
    if (output.length < 8 && !output.some(item => JSON.stringify(item) === JSON.stringify(candidate))) output.push(candidate);
  };
  const keyGroups = new Map<Element, Extract<SecretCandidate, { kind: 'key' }>[]>();
  for (const element of elements) {
    if (output.length >= 8 || work <= 0) break;
    const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    if (field && !fields.includes(element as HTMLInputElement)
      && !(element instanceof HTMLTextAreaElement && !element.disabled && laidOut(element))) {
      continue;
    }
    if (!laidOut(element) || KEY_ID.test(hint(element))) continue;
    const structuralResult = element.tagName === 'OUTPUT' || (field && element.readOnly);
    const ownContext = context(element);
    if (EXCLUDED.test(ownContext)) continue;
    if (!field && !['CODE', 'OUTPUT', 'PRE', 'SAMP'].includes(element.tagName)
      && !(element.childElementCount === 0 && (API.test(hint(element)) || GENERATED.test(ownContext)
        || options.trustedGeneratedResult))) {
      continue;
    }
    const raw = field ? element.value : text(element, 4097);
    if (raw.length > 4096) continue;
    const token = raw.trim();
    const known = /^(?:sk_(?:live_|test_)?|sk-proj-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{20,}$/.test(token);
    const trustedResult = options.trustedGeneratedResult && options.scope && (structuralResult || !field);
    if (!API.test(ownContext) && !(known && (GENERATED.test(ownContext) || trustedResult))) continue;
    if (token.length < 8 || /\s|[•*<>\u0000-\u001f\u007f]/.test(token)
      || /^[\da-f]{8}-[\da-f-]{27,}$/i.test(token) || /^\d+$/.test(token)) continue;
    const group = localGroup(element);
    const candidate: Extract<SecretCandidate, { kind: 'key' }> = { kind: 'key', value: token };
    add(candidate);
    if (group) {
      const keys = keyGroups.get(group) ?? [];
      keys.push(candidate);
      keyGroups.set(group, keys);
    }
  }
  for (const [group, keys] of keyGroups) {
    if (keys.length !== 1) continue;
    const ids = fields.filter(item => localGroup(item) === group && KEY_ID.test(hint(item)));
    const keyId = ids.length === 1 ? ids[0]!.value : '';
    if (keyId && keyId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(keyId)) keys[0]!.keyId = keyId;
  }
  const groups = new Map<Element, (HTMLInputElement | HTMLSelectElement)[]>();
  for (const field of fields) {
    const group = localGroup(field) ?? field;
    const list = groups.get(group) ?? [];
    list.push(field);
    groups.set(group, list);
  }
  for (const [groupElement, group] of groups) {
    const standard = (name: string): (HTMLInputElement | HTMLSelectElement)[] => group.filter(field =>
      (field.getAttribute('autocomplete') ?? '').slice(0, 256).split(/\s+/).includes(name));
    const single = (name: string): string => {
      const matches = standard(name);
      return matches.length === 1 && matches[0]!.value.length <= 256 ? matches[0]!.value : '';
    };
    const unnamedExp = group.filter(field => field.value.length <= 12
      && /^(\d{1,2})\s*[/ -]\s*(\d{2}|\d{4})$/.test(field.value));
    const monthInput = group.find(field => field instanceof HTMLInputElement
      && field.type === 'month' && /^\d{4}-\d{2}$/.test(field.value));
    const expiry = single('cc-exp') || (unnamedExp.length === 1 ? unnamedExp[0]!.value : '');
    const exp = expiry.match(/^(\d{1,2})\s*[/ -]\s*(\d{2}|\d{4})$/);
    const paymentContext = !!monthInput || !!exp || standard('cc-exp-month').length === 1 || standard('cc-csc').length === 1;
    let pans = standard('cc-number');
    if (!pans.length && paymentContext) {
      pans = group.filter(field => field.value.length <= 25 && /^[\d -]{12,25}$/.test(field.value)
        && luhn(field.value.replace(/[ -]/g, '')));
    }
    const numbers = pans.filter(field => field.value.length <= 25).map(field => field.value.replace(/[ -]/g, ''));
    if (!numbers.length && paymentContext) {
      for (let i = 0; i <= group.length - 4; i++) {
        const split = group.slice(i, i + 4);
        if (split.every(field => field instanceof HTMLInputElement
          && field.maxLength === 4 && /^\d{4}$/.test(field.value))) {
          numbers.push(split.map(field => field.value).join(''));
        }
      }
    }
    if (numbers.length !== 1 || !luhn(numbers[0]!)) continue;
    const month = single('cc-exp-month') || exp?.[1] || monthInput?.value.slice(5) || '';
    const year = single('cc-exp-year') || exp?.[2] || monthInput?.value.slice(0, 4) || '';
    add({
      kind: 'card',
      ...(options.cardScopeId ? { scopeId: options.cardScopeId(groupElement) } : {}),
      cardNumber: numbers[0]!,
      cardholderName: single('cc-name'),
      expiryMonth: /^(0?[1-9]|1[0-2])$/.test(month) ? month : '',
      expiryYear: /^(\d{2}|\d{4})$/.test(year) ? year : '',
    });
  }
  return output;
}
