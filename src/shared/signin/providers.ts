/**
 * Federated sign-in providers that Palladin can recognize for an external
 * service. Provider identity in the browser is taken only from the
 * browser-authored URL of a known authorization endpoint, never from page text.
 */

export const SIGN_IN_PROVIDERS = ['google', 'apple', 'microsoft', 'github', 'facebook'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return typeof value === 'string' && (SIGN_IN_PROVIDERS as readonly string[]).includes(value);
}

export const SIGN_IN_PROVIDER_NAMES: Readonly<Record<SignInProvider, string>> = {
  google: 'Google',
  apple: 'Apple',
  microsoft: 'Microsoft',
  github: 'GitHub',
  facebook: 'Facebook',
};

/** Registrable domains whose Credentials are candidate provider accounts. */
export const SIGN_IN_PROVIDER_ACCOUNT_DOMAINS: Readonly<Record<SignInProvider, readonly string[]>> = {
  google: ['google.com'],
  apple: ['apple.com'],
  microsoft: ['live.com', 'microsoftonline.com', 'microsoft.com'],
  github: ['github.com'],
  facebook: ['facebook.com'],
};

export interface ProviderPage {
  readonly provider: SignInProvider;
  /** A third-party authorization request (`client_id` present), not the provider's own sign-in. */
  readonly authorizationRequest: boolean;
}

/**
 * Exact HTTPS authorization and provider-owned sign-in documents. One-Tap/FedCM
 * prompts rendered by the browser or inside a provider iframe are not visible
 * here and intentionally fall back to the explicit choice in Palladin. Only the
 * presence of `client_id` is read; no OAuth parameter value is kept.
 */
export function classifyProviderUrl(raw: string): ProviderPage | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const request = (provider: SignInProvider): ProviderPage =>
    ({ provider, authorizationRequest: url.searchParams.has('client_id') });
  switch (host) {
    case 'accounts.google.com':
      // OAuth redirects commit on /v3/signin or /signin/oauth with the relying party's client_id.
      return /^\/(?:o\/oauth2\/|gsi\/select(?:\/|$)|signin\/oauth|v3\/signin\/|AccountChooser|ServiceLogin)/.test(path)
        ? request('google') : null;
    case 'appleid.apple.com':
      return /^\/auth\/(?:oauth2\/(?:v2\/)?)?authorize(?:\/|$)/.test(path) ? request('apple') : null;
    case 'login.microsoftonline.com':
      return /^\/[^/]+\/oauth2\/(?:v2\.0\/)?authorize(?:\/|$)/.test(path) ? request('microsoft') : null;
    case 'login.live.com':
      return path === '/oauth20_authorize.srf' ? request('microsoft') : null;
    case 'github.com':
      if (/^\/login\/oauth\/authorize(?:\/|$)/.test(path)) return request('github');
      if (path !== '/login') return null;
      {
        const returnTo = url.searchParams.get('return_to') ?? '';
        if (!returnTo.startsWith('/login/oauth/authorize')) return null;
        return { provider: 'github', authorizationRequest: new URL(returnTo, url.origin).searchParams.has('client_id') };
      }
    case 'www.facebook.com':
    case 'm.facebook.com':
    case 'web.facebook.com':
      return /^\/(?:v\d+\.\d+\/)?dialog\/oauth(?:\/|$)/.test(path) ? request('facebook') : null;
    default:
      return null;
  }
}

export function providerForAuthorizationUrl(raw: string): SignInProvider | null {
  return classifyProviderUrl(raw)?.provider ?? null;
}

/** True for any host owned by a supported provider's sign-in surface. */
export function isProviderSignInHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return ['accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'login.microsoftonline.com',
      'login.live.com', 'github.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(host);
  } catch { return false; }
}

/**
 * A return URL carrying an OAuth/OIDC error parameter means the user denied or
 * cancelled. Only the presence of the standard `error` name is inspected; no
 * authorization code, state or token value is read or kept.
 */
export function isAuthorizationErrorReturn(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.searchParams.has('error')) return true;
    const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    return fragment.length > 0 && new URLSearchParams(fragment).has('error');
  } catch { return false; }
}
