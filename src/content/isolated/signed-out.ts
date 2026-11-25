import { isVisibleScopeHint, publicActionLabels } from './login-controls';
import { queryOpenElements } from './open-dom';

export type SignedState =
  | { readonly state: 'signed-out'; readonly entry: HTMLElement | null }
  | { readonly state: 'signed-in' | 'unknown' };

const MAX_CONTROLS = 2_000;
const CONTROLS = 'a, button, [role="button"], [role="menuitem"], input[type="submit"], input[type="button"]';
const SIGN_IN = new Set(['log in', 'login', 'sign in', 'sign in to console', 'sign in to the console', 'log in now', 'sign in now',
  'zaloguj', 'zaloguj się', 'logowanie', 'anmelden', 'einloggen', 'se connecter', 'connexion', 'iniciar sesión', 'entrar', 'fazer login',
  'accedi', 'inloggen', 'log ind', 'logg inn', 'logga in', 'kirjaudu', 'kirjaudu sisään', 'přihlásit', 'přihlásit se', 'prihlásiť sa', 'prijava', 'prijavi se',
  'bejelentkezés', 'belépés', 'войти', 'увійти', 'giriş yap', '登录', '登入', 'ログイン', '로그인']);
const SIGN_OUT = /^(?:log ?out|sign ?out|log off|wyloguj(?: się)?|abmelden|ausloggen|se déconnecter|déconnexion|cerrar sesión|sair|esci|uitloggen|log ud|logg ut|logga ut|odhlásit(?: se)?|выйти|вийти|çıkış yap|退出|ログアウト|로그아웃)$/iu;

function names(element: Element): string[] {
  return publicActionLabels(element).map(label => label.replace(/\s+/g, ' ').trim()).filter(label => /[\p{L}]/u.test(label));
}

/** Evidence from public controls only. A conflict or silence means unknown, so no prompt. */
export function observeSignedState(doc: Document, hasSignInForm: boolean): SignedState {
  const controls = queryOpenElements<HTMLElement>(doc, CONTROLS).slice(0, MAX_CONTROLS);
  const entries: HTMLElement[] = [];
  for (const control of controls) {
    const labels = names(control);
    // A collapsed menu still proves a session: its sign-out control is in the DOM.
    if (labels.some(label => SIGN_OUT.test(label))) return { state: 'signed-in' };
    if (!isVisibleScopeHint(control)) continue;
    if (labels.length > 0 && labels.every(label => SIGN_IN.has(label) || /^hello, sign in\b/.test(label))) entries.push(control);
  }
  if (hasSignInForm) return { state: 'signed-out', entry: null };
  if (entries.length === 0) return { state: 'unknown' };
  return { state: 'signed-out', entry: uniqueDestination(entries, doc) };
}

/** Header and footer often repeat one link; different destinations are never guessed between. */
function uniqueDestination(entries: readonly HTMLElement[], doc: Document): HTMLElement | null {
  const top = entries.filter(entry => !entries.some(other => other !== entry && other.contains(entry)));
  if (top.length === 1) return top[0]!;
  const targets = top.map(entry => {
    if (!(entry instanceof HTMLAnchorElement) || !entry.hasAttribute('href')) return null;
    try {
      const url = new URL(entry.href, doc.baseURI);
      return url.protocol === 'https:' ? url.origin + url.pathname : null;
    } catch { return null; }
  });
  return targets[0] !== null && targets.every(target => target === targets[0]) ? top[0]! : null;
}
