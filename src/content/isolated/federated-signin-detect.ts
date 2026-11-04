import { classifyProviderUrl, SIGN_IN_PROVIDERS, type SignInProvider } from '@shared/signin/providers';

/**
 * Value-free detection of "Continue with <provider>" controls on a service page.
 * The result is only a hint for showing remembered choices and recording a
 * trusted click: it never identifies an account, never authorizes anything and
 * the worker confirms the provider from the browser-authored provider URL.
 */

const CONTROL_SELECTOR = 'button, a[href], [role="button"], input[type="button"], input[type="submit"]';
const MAX_CONTROLS = 600;
const MAX_NAME_LENGTH = 120;

const BRANDS: Readonly<Record<SignInProvider, RegExp>> = {
  google: /\bgoogle\b/,
  apple: /\bapple\b/,
  microsoft: /\b(?:microsoft|outlook)\b/,
  github: /\bgithub\b/,
  facebook: /\bfacebook\b/,
};

const SIGN_IN_WORDS = /\b(?:continue|sign\s*in|sign\s*up|log\s*in|login|connect|with|using|via|przez|kontynuuj|zaloguj|zarejestruj|pomoc[aą]|mit|anmelden|avec|connexion|continuer|con|iniciar|accedi|entrar)\b/;

export interface ProviderControl {
  readonly provider: SignInProvider;
  readonly element: HTMLElement;
}

function accessibleName(element: Element): string {
  const parts = [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element instanceof HTMLInputElement ? element.value : element.textContent,
    ...[...element.querySelectorAll('img[alt]')].map((image) => image.getAttribute('alt')),
  ];
  return parts.filter((part): part is string => typeof part === 'string')
    .join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_NAME_LENGTH * 2);
}

export function providerForControl(element: Element): SignInProvider | null {
  if (element instanceof HTMLAnchorElement) {
    const direct = classifyProviderUrl(element.href);
    if (direct !== null) return direct.provider;
  }
  const name = accessibleName(element);
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  const matches = SIGN_IN_PROVIDERS.filter((provider) => BRANDS[provider].test(name));
  if (matches.length !== 1) return null;
  const provider = matches[0]!;
  const bare = name.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  // Icon-only buttons usually carry just the brand as their accessible name.
  return SIGN_IN_WORDS.test(name) || bare === provider ? provider : null;
}

/** Visible provider controls in the top document, bounded and ignoring Palladin surfaces. */
export function detectProviderControls(
  doc: Document,
  isVisible: (element: HTMLElement) => boolean,
  isOwnedSurface: (element: Element) => boolean,
): ProviderControl[] {
  const controls: ProviderControl[] = [];
  const candidates = [...doc.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].slice(0, MAX_CONTROLS);
  for (const element of candidates) {
    if (isOwnedSurface(element) || element.closest('[data-palladin-ignore="true"]')) continue;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue;
    const provider = providerForControl(element);
    if (provider === null || !isVisible(element)) continue;
    if (controls.some((control) => control.element.contains(element) || element.contains(control.element))) continue;
    controls.push({ provider, element });
  }
  return controls;
}

/** The single control for a provider, or null when absent or ambiguous. */
export function uniqueProviderControl(controls: readonly ProviderControl[], provider: SignInProvider): HTMLElement | null {
  const matches = controls.filter((control) => control.provider === provider);
  return matches.length === 1 ? matches[0]!.element : null;
}
