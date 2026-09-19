/** Value-free DOM semantics shared by user autofill, capture and Agent inspection.
 * No transports, credential values, grants or page text leave this module.
 */
import { identityLabelPurpose, isFullNameLabel, isOneTimeCodeLabel, normalizedControlLabels, personalNameLabelPurpose } from './control-labels';

export type FormControlPurpose =
  | 'username' | 'new-password' | 'current-password' | 'confirm-password'
  | 'one-time-code' | 'email' | 'name' | 'given-name' | 'family-name'
  | 'organization' | 'tel' | 'country' | 'postal-code' | 'street-address';
export type FormControlKind = 'text' | 'email' | 'password' | 'tel' | 'url' | 'number'
  | 'textarea' | 'select' | 'radio' | 'checkbox' | 'button';

export function autocompleteTokens(element: Element): string[] {
  return (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
}

export function hasOneTimeCodeHint(element: Element): boolean {
  return autocompleteTokens(element).includes('one-time-code')
    || normalizedControlLabels(element).some(isOneTimeCodeLabel);
}

export function standardControlKind(element: Element): FormControlKind | null {
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLSelectElement) return element.multiple ? null : 'select';
  if (element instanceof HTMLButtonElement) return 'button';
  if (!(element instanceof HTMLInputElement)) return null;
  switch (element.type) {
    case 'text': case 'email': case 'password': case 'tel': case 'url': case 'number':
    case 'radio': case 'checkbox': return element.type;
    case 'search': return 'text';
    case 'submit': case 'button': return 'button';
    default: return null;
  }
}

const AUTOCOMPLETE_PURPOSES = new Set<FormControlPurpose>([
  "username", "new-password", "current-password", "one-time-code", "email", "name",
  "given-name", "family-name", "organization", "tel", "country", "postal-code", "street-address",
]);

export function controlPurpose(element: Element, kind = standardControlKind(element)): FormControlPurpose | null {
  const tokens = autocompleteTokens(element);
  if (kind !== "password" && hasOneTimeCodeHint(element)) return "one-time-code";
  const hints = new Set(tokens.filter((token): token is FormControlPurpose => AUTOCOMPLETE_PURPOSES.has(token as FormControlPurpose)));
  if (hints.size > 1) return null;
  const hint = [...hints][0];
  if (hint !== undefined && (kind === "password") === (hint === "new-password" || hint === "current-password")) {
    return hint;
  }
  if (hint !== undefined) return null;
  // Recognize complete labels locally; page-controlled text never leaves the isolated world.
  const normalized = normalizedControlLabels(element);
  const matches = new Set<FormControlPurpose>();
  for (const name of normalized) {
    if (kind === "password") {
      if (["confirm password", "password confirmation", "repeat password", "potwierdź hasło", "powtórz hasło", "confirm", "confirmation"].includes(name)) matches.add("confirm-password");
      if (["new password", "nowe hasło"].includes(name)) matches.add("new-password");
      if (["current password", "obecne hasło"].includes(name)) matches.add("current-password");
    } else if (kind === "text" || kind === "email" || kind === "tel" || kind === "number") {
      const identity = identityLabelPurpose(name);
      if (identity) matches.add(identity);
      if (isFullNameLabel(name)) matches.add("name");
      if (isOneTimeCodeLabel(name)) matches.add("one-time-code");
      if (['手机号', '请输入手机号'].includes(name)) matches.add('tel');
      const personalName = personalNameLabelPurpose(name);
      if (personalName) matches.add(personalName);
    }
  }
  // A generic technical name is compatible with a specific personal-name label.
  // Conflicting given/family names or identity meanings remain ambiguous.
  if (matches.size === 2 && matches.has("name")) {
    if (matches.has("given-name")) return "given-name";
    if (matches.has("family-name")) return "family-name";
  }
  if (matches.size === 1) return [...matches][0]!;
  if (matches.size > 1) return null;
  return kind === "email" ? "email" : kind === "tel" ? "tel" : null;
}
