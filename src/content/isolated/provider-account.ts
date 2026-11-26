import { isObservableSignInAccount } from '@shared/messaging/federated-signin';
import { isGoogleAccountPage } from '@shared/signin/providers';

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
