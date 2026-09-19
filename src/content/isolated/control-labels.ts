/** Public control metadata only. Shared by user and Agent discovery; never reads values. */
export function normalizedControlLabels(element: Element): string[] {
  const names = [element.getAttribute('name'), element.id, element.getAttribute('aria-label'), element.getAttribute('placeholder')];
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
    for (const label of element.labels ?? []) names.push(label.textContent);
  }
  return names.filter((name): name is string => name !== null && name.length <= 256)
    .map(name => name.trim().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
      .replace(/\s*:\s*\*?$|\s*\*$/, '').trim()
      .replace(/^(?:enter|type|wpisz|podaj)\s+(?:(?:your|swój|swoj|swój adres)\s+)?(username|login|email|e mail)(?:\.{1,3}|…)?$/, '$1'));
}

const USERNAME_LABELS = new Set(['username', 'user name', 'user id', 'identifier', 'login', 'nazwa użytkownika', 'uporabniško ime',
  'mobile number or email', 'phone number or email', 'email or mobile number', 'email or phone', 'phone or email',
  'adres e mail lub numer telefonu', 'numer telefonu lub adres e mail', 'login lub e mail', 'login lub adres e mail', '账号', '请输入账号',
  'prihlasovacie meno alebo e mailová adresa']);
const EMAIL_LABELS = new Set(['email', 'e mail', 'email address', 'adres e mail', 'adres email', 'netfang']);

export function isOneTimeCodeLabel(label: string): boolean {
  return ['otp', 'one time code', 'verification code', 'kod jednorazowy', 'kod weryfikacyjny', '验证码', '请输入验证码'].includes(label);
}

export function isEmailConfirmationLabel(label: string): boolean {
  const normalized = label.replace(/\s*:\s*\*?$|\s*\*$/, '').trim();
  const suffix = normalized.match(/^(.+) (?:again|confirmation|\(endurtekið\))$/)?.[1];
  const prefix = normalized.match(/^(?:repeat|confirm|powtórz|potwierdź) (.+)$/)?.[1];
  return (suffix !== undefined && EMAIL_LABELS.has(suffix)) || (prefix !== undefined && EMAIL_LABELS.has(prefix));
}

export function isFullNameLabel(label: string): boolean {
  return ['name', 'full name', 'imię i nazwisko', 'imie i nazwisko', 'pełne imię i nazwisko'].includes(label);
}

export function personalNameLabelPurpose(label: string): 'given-name' | 'family-name' | null {
  if (['first name', 'given name', 'imie', 'imię'].includes(label)) return 'given-name';
  if (['last name', 'family name', 'surname', 'nazwisko'].includes(label)) return 'family-name';
  return null;
}

export function identityLabelPurpose(label: string): 'username' | 'email' | null {
  // Frameworks often namespace signup controls (for example signupUsername).
  // Match a complete identity label, never an arbitrary substring such as usernameSearch.
  const identity = label.replace(/^(?:signup|sign up|registration|register) /, '')
    .replace(/\s+\(required\)$/, '').replace(/\s*:\s*\*?$|\s*\*$/, '').trim();
  return USERNAME_LABELS.has(identity) ? 'username' : EMAIL_LABELS.has(identity) ? 'email' : null;
}
