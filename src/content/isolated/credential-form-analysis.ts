/** Shared value-free credential discovery. DOM writes live in fill/Agent adapters. */
import { composedParent } from './open-dom';
import { normalizedControlLabels, personalNameLabelPurpose } from './control-labels';
import { autocompleteTokens, controlPurpose } from './form-semantics';
import { credentialScopeFor, scopeInputs, usernameCandidates, isIdentifiedUsername, isVisibleScopeHint,
  scopeHasCredentialAction, isRegistrationScope, isSubscriptionIdentity, isCollapsedClip, hasRegistrationSubmit,
  hasExplicitPasswordLogin, isOneTimeCodeControl, type CredentialScope } from './login-controls';

type FillControl = HTMLInputElement | HTMLTextAreaElement;

export interface LoginTarget {
  readonly username: HTMLInputElement | null;
  readonly password: HTMLInputElement | null;
  readonly form: CredentialScope;
  readonly accountIdentity?: HTMLInputElement;
}

/** Fail closed for disabled, hidden, or page-CSS-hidden controls. */
export function isFillable(input: FillControl): boolean {
  if (input.disabled || input.matches(":disabled") || input.readOnly) return false;
  if (input.hidden || (input instanceof HTMLInputElement && input.type === "hidden")) return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const style = input.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
    return false;
  }
  if (/opacity\s*:\s*0(?:\D|$)/i.test(style) || /pointer-events\s*:\s*none/i.test(style)) {
    return false;
  }
  const view = input.ownerDocument.defaultView;
  if (view === null) return false;
  // pointer-events is inherited but descendants may override it (Netflix does).
  // The field's computed value is authoritative; ancestor opacity/visibility
  // still applies even when the field overrides pointer handling.
  if (view.getComputedStyle(input).pointerEvents === "none") return false;
  for (let element: Element | null = input; element !== null; element = composedParent(element)) {
    if (element.hasAttribute('hidden')
      || element.hasAttribute("inert")
      || element.getAttribute("aria-hidden") === "true"
      || (element.tagName === "DIALOG" && !element.hasAttribute("open"))) {
      return false;
    }
    const computed = view.getComputedStyle(element);
    if (isCollapsedClip(computed) || computed.display === "none"
      || computed.visibility === "hidden"
      || computed.visibility === "collapse"
      || Number.parseFloat(computed.opacity) === 0
      || computed.getPropertyValue("content-visibility") === "hidden") {
      return false;
    }
  }
  const clientRects = input.getClientRects();
  if (clientRects.length > 0) {
    const bounds = input.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
  }
  return true;
}

/** One launcher per unambiguous login step, including password-only screens. */
export function loginTargetFor(input: HTMLInputElement): LoginTarget | null {
  if (!isFillable(input)) return null;
  const apple = appleLoginTargetFor(input);
  if (apple !== undefined) return apple;
  const form = credentialScopeFor(input);
  if (!form) return null;
  const all = scopeInputs(form);
  // Some signup pages enable their password inputs individually on focus.
  // A still-visible readonly password is not an absent password/identifier step.
  if (all.some(field => field.type === 'password' && field.readOnly && isVisibleScopeHint(field))) return null;
  const fields = all.filter(isFillable);
  const analysis = analyzeCredentialForm(form, fields);
  if (analysis.stage !== 'login' && analysis.stage !== 'identifier') return null;
  const passwords = analysis.passwords;
  if (passwords.length > 1) return null;
  const candidates = analysis.usernames;
  if (candidates.length > 1) return null;
  const username = candidates[0] ?? null;
  const password = passwords[0] ?? null;
  if (password && !username && !password.autocomplete.includes("current-password")
    && !scopeHasCredentialAction(form)) return null;
  if (!password) {
    // Hidden new-password hints still prevent a signup from becoming a login step.
    if (all.some((field) => field.type === "password" && autocompleteTokens(field).includes('new-password'))) return null;
  }
  if (input !== (username ?? password)) return null;
  return { username, password, form };
}

function appleLoginTargetFor(input: HTMLInputElement): LoginTarget | null | undefined {
  if (input.ownerDocument.location.origin !== 'https://idmsa.apple.com') return undefined;
  const username = input.ownerDocument.getElementById('account_name_text_field');
  const password = input.ownerDocument.getElementById('password_text_field');
  const form = username instanceof HTMLInputElement ? username.closest<HTMLElement>('#sign_in_form') : null;
  if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)
    || username.type !== 'text' || password.type !== 'password'
    || form === null || form !== password.closest('#sign_in_form')) return undefined;
  const passwordVisible = !form.classList.contains('hide-password') && isFillable(password);
  if (input === username && isFillable(username) && !passwordVisible) {
    return { username, password: null, form };
  }
  if (input === password && passwordVisible && username.value !== '') {
    return { username: null, password, form, accountIdentity: username };
  }
  return null;
}

/** Revalidate the same controls and scope immediately before a DOM write. */
export function isCurrentLoginTarget(target: LoginTarget): boolean {
  const anchor = target.username ?? target.password;
  if (!anchor?.isConnected || !target.form.isConnected) return false;
  const current = loginTargetFor(anchor);
  return current !== null && current.form === target.form
    && current.username === target.username && current.password === target.password
    && current.accountIdentity === target.accountIdentity;
}


export type CredentialFormStage = 'identifier' | 'verification' | 'login' | 'registration' | 'password-change' | 'unknown';

/** Classify one scoped set of public controls; never inspect a field value.
 * Visibility and execution policy are supplied by each caller before this step.
 */
export function analyzeCredentialForm(form: CredentialScope, fields: readonly HTMLInputElement[]) {
  const passwords = fields.filter(field => field.type === 'password');
  const explicitLogin = passwords.some(field => autocompleteTokens(field).includes("new-password"))
    && hasExplicitPasswordLogin(form, fields);
  // Some account-creation forms mark their confirmation as current-password.
  // Require local native creation intent and an exact confirmation label; never
  // reinterpret an actual old/current-password label on a password-change form.
  const confirmations = !explicitLogin && passwords.length === 2 && hasRegistrationSubmit(form)
    && passwords.some(field => autocompleteTokens(field).includes('new-password')) ? passwords.filter(field => {
      if (!autocompleteTokens(field).includes('current-password') || autocompleteTokens(field).includes('new-password')) return false;
      const labels = normalizedControlLabels(field);
      return labels.some(label => ['confirm password', 'password confirmation', 'repeat password', 'powtórz hasło', 'potwierdź hasło'].includes(label))
        && !labels.some(label => ['current password', 'old password', 'obecne hasło', 'stare hasło'].includes(label));
    }) : [];
  const current = passwords.filter((field) => (!confirmations.includes(field)
      && (autocompleteTokens(field).includes("current-password") || controlPurpose(field) === 'current-password'))
    || (explicitLogin && autocompleteTokens(field).includes("new-password")));
  const hasNew = passwords.some(field => autocompleteTokens(field).includes('new-password') || controlPurpose(field) === 'new-password');
  const next = passwords.filter((field) => !explicitLogin && (autocompleteTokens(field).includes("new-password")
    || controlPurpose(field) === 'new-password' || (hasNew && controlPurpose(field) === 'confirm-password')
    || confirmations.includes(field)));
  const usernames = usernameCandidates(fields);
  const stage: CredentialFormStage = current.length === 1 && next.length > 0 ? 'password-change'
    : isRegistrationScope(form, fields) ? 'registration'
      : passwords.length === 0 ? identifierStage(form, fields, usernames)
        : passwords.length === 1 ? 'login' : 'unknown';
  return { stage, usernames, passwords, current, next };
}

function identifierStage(form: CredentialScope, fields: readonly HTMLInputElement[], usernames: readonly HTMLInputElement[]): CredentialFormStage {
  if (fields.some(isOneTimeCodeControl)) return 'verification';
  const purposes = new Set(fields.flatMap(field => [
    ...autocompleteTokens(field), ...normalizedControlLabels(field).map(personalNameLabelPurpose).filter(Boolean),
  ]));
  if (purposes.has('given-name') && purposes.has('family-name')) return 'unknown';
  const username = usernames[0];
  return usernames.length === 1 && username && isIdentifiedUsername(username)
    && !isSubscriptionIdentity(username) && scopeHasCredentialAction(form) ? 'identifier' : 'unknown';
}
