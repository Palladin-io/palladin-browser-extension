import { identityLabelPurpose, isEmailConfirmationLabel, isFullNameLabel, normalizedControlLabels } from './control-labels';
import { controlPurpose, hasOneTimeCodeHint, autocompleteTokens } from './form-semantics';
import { actionCaption, composedForm, composedParent, queryOpenElements } from './open-dom';

/** DOM discovery only; the worker remains the authority for credential access. */
export type CredentialScope = HTMLFormElement | HTMLElement;

/** A zero-area clipping box hides descendants even when they have nonzero rects.
 * Do not reject zero-height wrappers that intentionally allow visible overflow.
 */
export function isCollapsedClip(style: CSSStyleDeclaration): boolean {
  const zero = (value: string) => Number.parseFloat(value) === 0;
  const empty = (value: string) => !Number.parseFloat(value);
  const clips = (value: string) => ['hidden', 'clip', 'scroll', 'auto'].includes(value);
  return (clips(style.overflowY || style.overflow) && zero(style.height)
      && empty(style.paddingTop) && empty(style.paddingBottom)
      && empty(style.borderTopWidth) && empty(style.borderBottomWidth))
    || (clips(style.overflowX || style.overflow) && zero(style.width)
      && empty(style.paddingLeft) && empty(style.paddingRight)
      && empty(style.borderLeftWidth) && empty(style.borderRightWidth));
}

export function scopeInputs(scope: CredentialScope): HTMLInputElement[] {
  const view = scope.ownerDocument.defaultView;
  if (!view) return [];
  const nested = queryOpenElements<HTMLInputElement>(scope, 'input');
  return scope instanceof view.HTMLFormElement
    ? [...new Set([...scope.elements].filter((field): field is HTMLInputElement => field instanceof view.HTMLInputElement)
      .concat(nested.filter(field => composedForm(field) === scope)))]
    : nested.filter(field => composedForm(field) === null);
}

export const ACTION_SELECTOR = 'button, input[type="submit"], input[type="button"], [role="button"], a.button:not([href]), div.btn_primary';
const AUTH_ACTION = /(?:\blog\s*in\b|\bsign\s*in\b|\bsign\s*up\b|\bcontinue\b|\bnext\b|\bsubmit\b|\bregister\b|\bcreate\s+account\b|\bsave\b|zaloguj|zarejestruj|dalej|kontynuuj|zapisz|utwórz\s+konto)/i;

const LOCALIZED_LOGIN_ACTIONS = new Set(['logowanie', 'συνέχεια', 'fortsett', 'fortsätt', 'continuar', 'weiter', 'anmelden',
  'prijavi se', 'entrar', 'log ind', '登录', 'continue with email']);
const EXACT_LOGIN_ACTION = /^(?:log\s*in|sign\s*in|continue|next|submit|zaloguj(?:\s+się)?|dalej|kontynuuj)$/i;

/** Bounded execution-only content: text plus independent semantic icon labels.
 * Explicitly referenced roots may be aria-hidden (e.g. native submit captions),
 * so only decorative descendants are skipped. This is not a full AccName engine.
 */
function executionActionContent(element: Element): string[] | null {
  const pending: Node[] = [element];
  const labels: string[] = [];
  let text = '', visited = 0, length = 0;
  const appendLabel = (label: string | null): boolean => {
    if (label === null || label === '') return true;
    length += label.length; labels.push(label);
    return length <= 512;
  };
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 256) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent ?? '';
      length += content.length; text += content;
      if (length > 512) return null;
    } else if (node instanceof Element) {
      if (node.matches('script, style, input, textarea')) continue;
      if (node !== element && (node.getAttribute('aria-hidden') === 'true'
        || (node.matches('img, svg') && ['none', 'presentation'].includes(node.getAttribute('role') ?? '')))) continue;
      // Descendant IDREF naming is not yet supported by this execution adapter.
      // Fail closed rather than silently dropping a provider's semantic name.
      if (node !== element && (node.getAttribute('aria-labelledby') ?? '').trim() !== '') return null;
      if (!appendLabel(node.getAttribute('aria-label'))
        || (node.matches('img') && !appendLabel(node.getAttribute('alt')))) return null;
      const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
      const children = assigned.length ? assigned : [...(node.shadowRoot ?? node).childNodes];
      pending.push(...children.reverse());
    }
  }
  return [text, ...labels];
}

export function publicActionLabels(element: Element, execution = false): string[] {
  const references = element.getAttribute('aria-labelledby');
  if (references !== null && references.length > 512) return [];
  if (references !== null && references.trim() !== '') {
    const root = element.getRootNode();
    const ids = references.trim().split(/\s+/);
    if (ids.length > 8 || !(root instanceof Document || root instanceof ShadowRoot)) return [];
    const labels = ids.map(id => root.getElementById(id));
    if (labels.some(label => label !== null)) {
      const contents = labels.map(label => label ? (execution ? executionActionContent(label) : [actionCaption(label)]) : null);
      if (contents.some(content => content === null || content.some(caption => caption === null))) return [];
      const captions = contents as string[][];
      const caption = captions.map(content => content[0]).join(' ').trim().replace(/\s+/g, ' ').toLowerCase();
      const own = execution ? executionActionContent(element) : [];
      if (own === null) return [];
      return caption.length <= 512 ? [caption, ...captions.flatMap(content => content.slice(1)), ...own]
        .map(label => label.trim().toLowerCase()) : [];
    }
  }
  const value = element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type)
    ? element.value : null;
  const content = execution ? executionActionContent(element) : [actionCaption(element)];
  if (content === null) return [];
  return [element.getAttribute('aria-label'), ...content, value]
    .filter((label): label is string => label !== null && label.length <= 512)
    .map(label => label.trim().toLowerCase());
}

/** Bind the source of a caption as well as its text across deferred commit. */
export function publicActionReferenceState(element: Element): readonly boolean[] | null {
  const references = element.getAttribute('aria-labelledby');
  if (references === null) return [];
  if (references.length > 512) return null;
  const ids = references.trim() ? references.trim().split(/\s+/) : [];
  const root = element.getRootNode();
  if (ids.length > 8 || !(root instanceof Document || root instanceof ShadowRoot)) return null;
  return ids.map(id => root.getElementById(id) !== null);
}

/** Execution uses the canonical login/continue labels, not the broader
 * registration and social-provider hints that may identify a credential scope.
 * The caller still enforces native type, visibility, owner and uniqueness.
 */
export function hasLoginActionLabel(element: Element): boolean {
  const recognized = (label: string) => EXACT_LOGIN_ACTION.test(label) || LOCALIZED_LOGIN_ACTIONS.has(label);
  const labels = publicActionLabels(element, true);
  if (!labels.some(recognized)) return false;
  // ARIA may override the accessible name, but must not hide a conflicting
  // visible action (social sign-in, account creation, reset, etc.) from execution.
  // Button.value is a submitted payload; only native input buttons expose it as
  // their caption. Never read credential input values.
  const content = executionActionContent(element);
  if (content === null) return false;
  const ownLabels = [element.getAttribute('aria-label') ?? '', ...content,
    element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type) ? element.value : ''];
  return [...labels, ...ownLabels].every(label => label !== null && label.length <= 512
    && (!/[\p{L}\p{N}]/u.test(label) || recognized(label.trim().toLowerCase())));
}

export function isCredentialAction(element: Element): boolean {
  if (element.matches(':disabled, [aria-disabled="true"]') || !isVisibleScopeHint(element)) return false;
  if (element.matches('div.btn_primary.disabled, div.btn_primary.disable')) return false;
  return isCredentialActionHint(element);
}

/** Disabled submit controls still identify a form before fields are populated.
 * Event capture and execution must use the enabled-action check above.
 */
function isCredentialActionHint(element: Element): boolean {
  // Skroutz fades in Continue after typing. Its explicit action text can identify
  // the step while transparent, but hidden containers and execution stay excluded.
  if (!isVisibleScopeHint(element, true)) return false;
  if (element.matches('div.btn_primary:not([role="button"])')) {
    return /^(?:登录|登录\s*\/\s*注册)$/.test((actionCaption(element) ?? '').trim());
  }
  // A button-styled, non-navigating anchor may own a form action. Ordinary
  // navigation links and longer explanatory/social captions are not actions.
  if (element.tagName === 'A' && !element.matches('[role="button"]')) {
    return element.matches('a.button:not([href])')
      && /^(?:log\s*in|sign\s*in|sign\s*up|register|continue|next|zaloguj(?:\s+się)?|zarejestruj(?:\s+się)?|dalej|kontynuuj)$/i.test((actionCaption(element) ?? '').trim());
  }
  if (element.matches('button[type="submit"], input[type="submit"], button:not([type])')
    && ((element as HTMLButtonElement).form || (element.getAttribute('type') === 'submit'
      && element.getRootNode() instanceof ShadowRoot && composedForm(element)))
    && isVisibleScopeHint(element)) return true;
  return publicActionLabels(element).some(label => AUTH_ACTION.test(label)
    || LOCALIZED_LOGIN_ACTIONS.has(label) || label === 'konto erstellen');
}

/** Hidden transport inputs and provider submit buttons do not compete with an
 * editable account form. Keep other forms and unowned editable fields separate.
 */
function editableControls(container: Element): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  return queryOpenElements<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(container, 'input, select, textarea')
    .filter(field => isVisibleScopeHint(field)
      && (field.tagName !== 'INPUT' || !['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(field.type)));
}

/** Keep unrelated forms separate; never pair credentials across a whole page. */
export function credentialScopeFor(element: Element): CredentialScope | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  const form = composedForm(element);
  if (form) return form;
  if (element.hasAttribute('form')) return null;
  for (let parent = composedParent(element); parent && parent !== element.ownerDocument.body; parent = composedParent(parent)) {
    const forms = queryOpenElements(parent, 'form');
    if (forms.length > 0) {
      const controls = editableControls(parent);
      const owners = new Set(controls.map(composedForm));
      return owners.size === 1 && !owners.has(null) ? composedForm(controls[0]!) : null;
    }
    if (parent instanceof view.HTMLElement && editableControls(parent).length > 0
      && queryOpenElements(parent, ACTION_SELECTOR).some(isCredentialActionHint)) return parent;
  }
  return null;
}

export function isOneTimeCodeControl(field: HTMLInputElement): boolean {
  return hasOneTimeCodeHint(field);
}

export function isUsernameControl(field: HTMLInputElement): boolean {
  if (!['text', 'email', 'tel'].includes(field.type)) return false;
  if (isOneTimeCodeControl(field)) return false;
  const tokens = field.autocomplete.toLowerCase().split(/\s+/);
  return !tokens.some((token) => token === 'one-time-code' || token.startsWith('cc-')
    || ['given-name', 'family-name', 'name', 'new-password', 'current-password', 'street-address'].includes(token));
}

export function isIdentifiedUsername(field: HTMLInputElement): boolean {
  if (!isUsernameControl(field)) return false;
  return field.type === 'email' || /(?:^|\s)(?:username|email)(?:\s|$)/i.test(field.autocomplete)
    || /^(?:username|user[_-]?name|email|identifier|login|session_key)$/i.test(field.name || field.id)
    || ['username', 'email'].includes(controlPurpose(field) ?? '');
}

/** Subscription-owned email controls are not an account identifier step.
 * Inspect only the identity control and its form owner's ID/name, not nearby
 * newsletter consent, other fields or unrelated forms.
 */
export function isSubscriptionIdentity(field: HTMLInputElement): boolean {
  const owner = composedForm(field);
  return [field.id, field.name, owner?.id ?? '', owner?.getAttribute('name') ?? ''].some(label => /(?:^|[\s_-])(?:newsletter|mailing|subscribe)(?:[\s_-]|$)/i
    .test(label.replace(/([a-z])([A-Z])/g, '$1 $2')));
}

export function isEmailConfirmationControl(field: HTMLInputElement): boolean {
  return ['text', 'email'].includes(field.type) && normalizedControlLabels(field).some(isEmailConfirmationLabel);
}

export function isVisibleScopeHint(element: Element, allowTransparentControl = false): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: Element | null = element; node; node = composedParent(node)) {
    const style = view.getComputedStyle(node);
    if (node.matches('[hidden], [inert], [aria-hidden="true"]') || style.display === 'none'
      || ['hidden', 'collapse'].includes(style.visibility)
      || (Number.parseFloat(style.opacity) === 0 && !(allowTransparentControl && node === element))
      || style.getPropertyValue('content-visibility') === 'hidden' || isCollapsedClip(style)) return false;
  }
  return true;
}

/** Some public login forms label their existing-password field new-password.
 * Override that hint only for a two-field account login with both a native login
 * submit and a visible password-recovery link in this same scope.
 */
export function hasExplicitPasswordLogin(scope: CredentialScope, fields: readonly HTMLInputElement[]): boolean {
  const accountFields = fields.filter(field => !['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(field.type));
  if (accountFields.length !== 2 || accountFields.filter(field => field.type === 'password').length !== 1
    || accountFields.filter(isIdentifiedUsername).length !== 1) return false;
  const submits = [...scope.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')]
    .filter(action => (action as HTMLButtonElement).form === scope);
  const submit = submits[0];
  if (submits.length !== 1 || !submit || !isVisibleScopeHint(submit)
    || !/^(?:log\s*in|sign\s*in)$/i.test((submit.textContent || submit.getAttribute('value') || '').trim())) return false;
  return [...scope.querySelectorAll('a')].some(link => isVisibleScopeHint(link)
    && /^forgot\s+(?:your\s+)?password\??$/i.test((link.textContent ?? '').trim()));
}

function hasAccountCreationHeading(scope: CredentialScope): boolean {
  return [...scope.querySelectorAll('header, h1, h2, h3, h4, h5, h6, legend')].some(heading => {
    const text = (heading.textContent ?? '').trim();
    return isVisibleScopeHint(heading) && isAccountCreationHeadingText(text);
  });
}

/** Shared public heading vocabulary; each caller supplies its own scope policy. */
export function isAccountCreationHeadingText(text: string): boolean {
  return text.length <= 256
    && /^(?:create\s+(?:(?:a|an|your)\s+)?account\b|sign\s*up\b|utw[oó]rz\s+konto\b|zał[oó]ż\s+konto\b|opprett\s+(?:[\p{L}\p{N}]{1,32}[ -])?(?:profil|konto)\b)/iu.test(text);
}

/** Some signup cards put the heading immediately outside their native form.
 * Only the sole form in that card may borrow it, with no competing controls.
 */
function hasSignupCardHeading(scope: CredentialScope): boolean {
  if (!(scope instanceof HTMLFormElement)) return false;
  const card = scope.parentElement;
  if (!card || card === scope.ownerDocument.body || card === scope.ownerDocument.documentElement) return false;
  const forms = queryOpenElements(card, 'form');
  if (forms.length !== 1 || forms[0] !== scope
    || queryOpenElements(card, 'input, select, textarea').some(control => composedForm(control) !== scope)) return false;
  return [...card.querySelectorAll('h1, h2, h3, h4, h5, h6')].some(heading =>
    !scope.contains(heading) && (heading.parentElement === card || heading.parentElement?.parentElement === card)
    && isVisibleScopeHint(heading)
    && /^zarejestruj się przez e-mail$/i.test((heading.textContent ?? '').trim()));
}

export function hasRegistrationSubmit(scope: CredentialScope): boolean {
  const submits = [...scope.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="submit"]')]
    .filter(action => action.type === 'submit' && action.form === scope && isVisibleScopeHint(action));
  return submits.length > 0 && submits.every(action => {
    const label = action.getAttribute('aria-label')
      || (action.tagName === 'INPUT' ? action.getAttribute('value') : action.textContent) || '';
    // Adjacent caption blocks may have no separating text node (CCC signup).
    // Accept the complete observed terms suffix, never arbitrary surrounding copy.
    return /^(?:sign\s*up|register|create\s+(?:(?:a|an|your)\s+)?account|zał[oó]ż\s+konto|zakładam\s+konto|stw[oó]rz\s+konto|utw[oó]rz\s+konto(?:\s+indywidualne)?|zarejestruj(?:\s+się)?(?:\s*i\s+zaakceptuj\s+regulamin\s+serwisu)?|rejestracja|注册)$/i.test(label.trim());
  });
}

/** Signup needs explicit local creation intent; a secondary link is insufficient.
 * Misannotated current-password requires an observed personal-profile layout.
 */
export function isRegistrationScope(scope: CredentialScope, fields: readonly HTMLInputElement[]): boolean {
  const passwords = fields.filter(field => field.type === 'password');
  if (!passwords.length) return fields.filter(isIdentifiedUsername).length >= 2 && hasRegistrationSubmit(scope);
  if (passwords.some(field => controlPurpose(field) === 'current-password'
    || autocompleteTokens(field).includes('current-password'))) {
    const accountFields = fields.filter(field => !['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(field.type));
    const hasPurpose = (token: string) => accountFields.some(field => field.autocomplete.toLowerCase().split(/\s+/).includes(token));
    const personalProfile = (accountFields.length === 3 && hasPurpose('name'))
      || (accountFields.length === 4 && hasPurpose('given-name') && hasPurpose('bday-year'));
    return passwords.length === 1 && personalProfile
      && accountFields.some(field => field.type === 'email' || field.autocomplete.toLowerCase().split(/\s+/).includes('email'))
      && hasAccountCreationHeading(scope);
  }
  if (passwords.some(field => controlPurpose(field) === 'new-password'
    || autocompleteTokens(field).includes('new-password'))) return !hasExplicitPasswordLogin(scope, fields);
  // Explicit native submit intent distinguishes a two-field signup from login.
  // Secondary Create account navigation buttons do not change a login's intent.
  if (hasRegistrationSubmit(scope)) return true;
  const labels = fields.filter(field => ['text', 'email'].includes(field.type))
    .flatMap(field => [...normalizedControlLabels(field), ...field.autocomplete.toLowerCase().split(/\s+/)]);
  const first = labels.some(label => ['first name', 'given name', 'given-name', 'imię', 'imie'].includes(label));
  const last = labels.some(label => ['last name', 'family name', 'family-name', 'surname', 'nazwisko'].includes(label));
  // A separate full name plus both contact identity and public handle is another
  // observed signup layout. A full name beside an ordinary login is insufficient.
  const fullName = labels.some(isFullNameLabel);
  const identities = fields.filter(field => ['text', 'email', 'tel', 'search'].includes(field.type)
    && normalizedControlLabels(field).some(label => identityLabelPurpose(label) !== null));
  const separateHandle = identities.some(field => normalizedControlLabels(field).some(label => identityLabelPurpose(label) === 'username'));
  const contactEmail = identities.some(field => field.type === 'email'
    && normalizedControlLabels(field).some(label => identityLabelPurpose(label) === 'email'));
  if (identities.length === 2 && separateHandle && contactEmail && hasAccountCreationHeading(scope)) return true;
  if (fullName && identities.length === 2 && separateHandle
    && identities.some(field => normalizedControlLabels(field).some(label => identityLabelPurpose(label) === 'email'))
    && hasSignupCardHeading(scope)) return true;
  const copy = scope.textContent ?? '';
  return ((first && last) || (fullName && identities.length >= 2)) && copy.length <= 10_000
    && /(?:\bcreate\s+(?:(?:a|an|your)\s+)?account\b|utw[oó]rz\s+konto|zał[oó]ż\s+konto)/i.test(copy);
}

export function usernameCandidates(fields: readonly HTMLInputElement[]): HTMLInputElement[] {
  const candidates = fields.filter(field => isUsernameControl(field) && !isEmailConfirmationControl(field));
  const explicit = candidates.filter((field) => field.autocomplete.toLowerCase().split(/\s+/).includes('username'));
  // Signup can request a login handle and a separate contact email. A complete
  // username label is more specific than the fallback email identity; two such
  // labels remain ambiguous. Conflicting labels do not earn that preference.
  const named = candidates.filter(field => {
    const purposes = new Set(normalizedControlLabels(field).map(identityLabelPurpose).filter(Boolean));
    return purposes.size === 1 && purposes.has('username');
  });
  const identified = candidates.filter(isIdentifiedUsername);
  return explicit.length ? explicit : named.length ? named : identified.length ? identified : candidates;
}

/** Some providers put Next beside the form instead of inside it. */
export function scopeHasCredentialAction(scope: CredentialScope): boolean {
  let container: Element | null = scope;
  while (container && container !== scope.ownerDocument.body) {
    if (queryOpenElements(container, ACTION_SELECTOR).some((action) =>
      isCredentialActionHint(action) && credentialScopeFor(action) === scope)) return true;
    container = composedParent(container);
    if (container && new Set(editableControls(container).map(composedForm)).size > 1) break;
  }
  return false;
}
