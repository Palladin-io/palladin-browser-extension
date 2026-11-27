import type { LoginTarget } from './credential-form-analysis';
import { isFillable, loginTargetFor } from './credential-form-analysis';
import { isVisibleScopeHint, scopeInputs } from './login-controls';
import { queryOpenElements } from './open-dom';
import { signInActionFor, type SignInAction } from './sign-in-action';
import { discoverTotpTargets } from './totp-target';

export interface CredentialStep {
  readonly kind: 'identifier' | 'password' | 'login';
  readonly target: LoginTarget;
  readonly action: SignInAction | null;
  /** A visible empty field Palladin has no value for, e.g. an AWS account ID. */
  readonly needsUser: boolean;
}
export type SignInStep = CredentialStep
  | { readonly kind: 'totp'; readonly inputs: HTMLInputElement[] }
  | { readonly kind: 'none' | 'ambiguous' };

const REGISTRATION_PATH = /(?:^|[/_.-])(?:sign-?up|register|registration|registrierung|rejestracja|join|inscription|create-?account|new-?account)(?:[/_.-]|$)/i;
const NON_TEXT = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);

export function isRegistrationUrl(url: string): boolean {
  try { return REGISTRATION_PATH.test(new URL(url).pathname); }
  catch { return true; }
}

function unfilledExtra(target: LoginTarget): boolean {
  return scopeInputs(target.form).some(input => input !== target.username && input !== target.password
    && !NON_TEXT.has(input.type) && isFillable(input) && input.value === '' && isVisibleScopeHint(input));
}

/** One value-free observation of the page. Uncertainty is never resolved by guessing. */
export function observeSignInStep(doc: Document, url: string): SignInStep {
  if (isRegistrationUrl(url)) return { kind: 'none' };
  const targets = queryOpenElements<HTMLInputElement>(doc, 'input').map(loginTargetFor).filter(target => target !== null);
  const totp = discoverTotpTargets(doc);
  if (targets.length + totp.length > 1) return { kind: 'ambiguous' };
  if (totp.length === 1) return { kind: 'totp', inputs: totp[0]! };
  const target = targets[0];
  if (target === undefined) return { kind: 'none' };
  const needsUser = unfilledExtra(target);
  // An identifier beside other empty fields is a form to complete, not a sign-in step.
  if (target.password === null && needsUser) return { kind: 'none' };
  return {
    kind: target.password === null ? 'identifier' : target.username === null ? 'password' : 'login',
    target, action: signInActionFor(target), needsUser,
  };
}
