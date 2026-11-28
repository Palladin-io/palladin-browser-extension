import type { LoginTarget } from './credential-form-analysis';
import { credentialScopeFor, isVisibleScopeHint, publicActionLabels } from './login-controls';
import { isCustomLoginAction } from './live-login-action';
import { composedForm, queryOpenElements } from './open-dom';

export interface SignInAction {
  readonly element: HTMLElement;
  /** Frameworks often enable or reveal the action only after the fields are filled. */
  readonly ready: boolean;
}

const CANDIDATES = 'button, input[type="submit"], input[type="button"], [role="button"], a.button:not([href]), div.btn_primary';
const LOGIN = new Set(['log in', 'login', 'sign in', 'continue', 'next', 'submit', 'log in with email', 'sign in with email', 'continue with email',
  'zaloguj', 'zaloguj się', 'zaloguj hasłem', 'logowanie', 'dalej', 'kontynuuj',
  'anmelden', 'einloggen', 'weiter', 'se connecter', 'connexion', 'continuer', 'suivant', 'iniciar sesión', 'entrar', 'continuar', 'siguiente',
  'accedi', 'avanti', 'continua', 'inloggen', 'ga verder', 'volgende', 'log ind', 'næste', 'logg inn', 'fortsett', 'logga in', 'fortsätt', 'nästa',
  'kirjaudu', 'skrá inn', 'belépés', 'přihlásit', 'přihlásit se', 'pokračovat', 'prihlásiť sa', 'prijavi', 'prijavi se', 'prijavite se',
  'συνέχεια', 'войти', 'далее', 'увійти', 'giriş yap', '登录', '登入', 'ログイン', '로그인']);
// A single match anywhere in a caption disqualifies the action: these start another flow.
const OTHER_FLOW = /google|apple|facebook|microsoft|amazon|github|twitter|linkedin|paypal|passkey|webauthn|biometr|face id|fingerprint|single sign|\bsso\b|\bqr\b|one[- ]time|\bcode\b|\bkod|\bsms\b|phone|telefon|forgot|reset|recover|trouble|\bhelp\b|pomoc|nie pami|zapomn|odzyska|przypomnij|znajdź|register|sign ?up|create|new account|zarejestruj|rejestracj|utwórz|załóż|show|hide|pokaż|ukryj|cancel|anuluj|zapomenut|bankovn|mojeid|elfelejtett|forgotten|mot de passe|passwort vergessen/iu;

function labels(element: Element): string[] {
  return publicActionLabels(element).map(label => label.replace(/\s+/g, ' ').trim()).filter(label => label !== '');
}

/** Public structure and captions only. Never reads a credential value. */
export function signInActionFor(target: LoginTarget): SignInAction | null {
  const scope = target.form;
  const input = target.username ?? target.password;
  if (input === null) return null;
  const native = scope instanceof HTMLFormElement ? scope : null;
  const elements = new Set<Element>(queryOpenElements(scope, CANDIDATES));
  if (native !== null) for (const control of native.elements) if (control.matches(CANDIDATES)) elements.add(control);
  const inside = resolve([...elements].filter(eligible), native);
  if (inside !== undefined || native === null) return inside ?? null;
  // Some sites render the action right after the form. Accept only a labelled
  // native button that the shared scope analysis assigns to this one form.
  const after = queryOpenElements(scope.parentElement?.parentElement ?? scope.parentElement ?? scope, 'button')
    .filter(element => !elements.has(element) && composedForm(element) === null
      && Boolean(scope.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      && credentialScopeFor(element) === scope && visibleCandidate(element)
      && labels(element).some(label => LOGIN.has(label))) as HTMLElement[];
  return after.length === 1 ? describe(after[0]!) : null;

  function eligible(element: Element): element is HTMLElement {
    if (element === input || !visibleCandidate(element)) return false;
    const owner = credentialScopeFor(element);
    if (owner !== scope && !(owner !== null && scope.contains(owner) && owner.contains(input))) return false;
    if (native !== null && composedForm(element) !== native) return false;
    return true;
  }
}

const VERIFY = new Set([...LOGIN, 'verify', 'verify code', 'confirm', 'authenticate', 'zweryfikuj', 'potwierdź', 'bestätigen', 'vérifier', 'verificar', 'verifica']);

/** The unique submit of an already classified authenticator-code scope. */
export function verificationActionFor(input: HTMLInputElement, scope: HTMLElement): SignInAction | null {
  const form = composedForm(input);
  const candidates = queryOpenElements<HTMLElement>(scope, CANDIDATES).filter(element => composedForm(element) === form && visibleCandidate(element));
  const labelled = candidates.filter(element => labels(element).some(label => VERIFY.has(label)));
  const group = labelled.length > 0 ? labelled : candidates.filter(element => form !== null
    && (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit');
  return group.length === 1 ? describe(group[0]!) : null;
}

function visibleCandidate(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !isVisibleScopeHint(element, true)) return false;
  if (element instanceof HTMLInputElement && !['submit', 'button'].includes(element.type)) return false;
  if (element instanceof HTMLButtonElement && element.type === 'reset') return false;
  if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return false;
  return !labels(element).some(label => OTHER_FLOW.test(label));
}

/** `undefined`: no action here. `null`: ambiguous, so nothing may be clicked. */
function resolve(candidates: readonly HTMLElement[], native: HTMLFormElement | null): SignInAction | null | undefined {
  const isSubmit = (element: HTMLElement) => native !== null
    && (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit';
  const isAction = (element: HTMLElement) => element instanceof HTMLButtonElement || element instanceof HTMLInputElement
    || element.getAttribute('role') === 'button' || isCustomLoginAction(element);
  const labelled = candidates.filter(element => isAction(element) && labels(element).some(label => LOGIN.has(label)));
  for (const group of [labelled.filter(isSubmit), labelled, candidates.filter(isSubmit)]) {
    if (group.length > 1) return null;
    if (group.length === 1) return describe(group[0]!);
  }
  return undefined;
}

function describe(element: HTMLElement): SignInAction {
  return { element, ready: isVisibleScopeHint(element)
    && !element.matches(':disabled, [aria-disabled="true"], .btn_primary.disabled, .btn_primary.disable') };
}
