import { isObservableSignInAccount, type ProviderScreenShape } from '@shared/messaging/federated-signin';
import { isGoogleAccountPage, isProviderSignInHost } from '@shared/signin/providers';

const IDENTIFIER = 'input#identifierId[name="identifier"]:not([type="password"])';

/**
 * Reports the account identifier the user submits on Google's own sign-in page.
 * The worker decides whether it belongs to an active flow; nothing is read while
 * typing, and no password, token or other page content is touched.
 */
export function observeProviderAccount(doc: Document, url: () => string, report: (account: string) => void,
  trusted: (event: Event) => boolean = event => event.isTrusted): () => void {
  const submitted = (event: Event) => {
    if (!trusted(event) || !(event.target instanceof Element) || !isGoogleAccountPage(url())) return;
    if (event instanceof KeyboardEvent
      ? event.key !== 'Enter' || !event.target.matches(IDENTIFIER)
      : event.target.closest('#identifierNext') === null) return;
    const account = doc.querySelector<HTMLInputElement>(IDENTIFIER)?.value.trim();
    if (account && isObservableSignInAccount(account)) report(account);
  };
  doc.addEventListener('click', submitted, true);
  doc.addEventListener('keydown', submitted, true);
  return () => {
    doc.removeEventListener('click', submitted, true);
    doc.removeEventListener('keydown', submitted, true);
  };
}

const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i;
const IDENTIFIER_FIELDS = 'input#identifierId, input[type="email"], input[autocomplete~="username"], input[autocomplete~="email"], '
  + 'input[name="identifier"], input[name="loginfmt"], input[name="login"], input[name="username"], input[name="email"], input[name="account_name"]';
const SCREEN_SETTLE_MS = 600;

/**
 * Value-free shape of the current provider sign-in screen, used only to learn
 * which screens still need account recognition. Flags only: no text, attribute
 * or field value leaves this function.
 */
export function describeProviderScreen(doc: Document): ProviderScreenShape {
  const visible = (element: Element) => element.getClientRects().length > 0;
  const identifierField = [...doc.querySelectorAll<HTMLInputElement>(IDENTIFIER_FIELDS)]
    .some(input => visible(input) && !input.disabled && input.type !== 'hidden' && input.type !== 'password');
  const passwordField = [...doc.querySelectorAll('input[type="password"]')].some(visible);
  const emailAttribute = [...doc.querySelectorAll('body *')].some(element =>
    visible(element) && [...element.attributes].some(attribute => attribute.name.startsWith('data-') && EMAIL.test(attribute.value)));
  const emailText = EMAIL.test(doc.body?.innerText ?? '');
  const kind = passwordField ? 'password' : emailAttribute ? 'account-chooser' : identifierField ? 'identifier' : emailText ? 'consent' : 'unknown';
  return { kind, identifierField, passwordField, emailAttribute, emailText };
}

/** Reports the provider screen shape after it settles and whenever it changes, on provider sign-in hosts only. */
export function watchProviderScreen(doc: Document, url: () => string, report: (screen: ProviderScreenShape) => void): () => void {
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    if (!isProviderSignInHost(url())) return;
    const screen = describeProviderScreen(doc);
    const key = JSON.stringify(screen);
    if (key !== last) { last = key; report(screen); }
  };
  const schedule = () => { if (timer === undefined) timer = setTimeout(check, SCREEN_SETTLE_MS); };
  if (!isProviderSignInHost(url())) return () => {};
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  schedule();
  return () => { observer.disconnect(); if (timer !== undefined) clearTimeout(timer); };
}
