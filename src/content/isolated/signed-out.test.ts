// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { observeSignedState } from './signed-out';

const state = (html: string, form = false) => { document.body.innerHTML = html; return observeSignedState(document, form); };
afterEach(() => document.body.replaceChildren());

describe('signed-out evidence', () => {
  it('needs a visible sign-in control or form', () => {
    expect(state('<a href="/about">About</a>').state).toBe('unknown');
    expect(state('<a href="/login">Sign in</a>')).toMatchObject({ state: 'signed-out', entry: expect.any(HTMLAnchorElement) });
    expect(state('<p>News</p>', true)).toEqual({ state: 'signed-out', entry: null });
  });
  it('treats a collapsed sign-out control as a session, even next to a sign-in word', () => {
    expect(state('<div hidden><button>Sign out</button></div><a href="/login">Sign in</a>').state).toBe('signed-in');
    expect(state('<div hidden><a href="/wyloguj">Wyloguj się</a></div>', true).state).toBe('signed-in');
  });
  it('accepts a sign-in link inside a collapsed account menu when no sign-out exists (synthetic, Allegro-like)', () => {
    expect(state('<button>Moje Allegro</button><div hidden><a href="https://example.com/logowanie">Zaloguj się</a></div>'))
      .toMatchObject({ state: 'signed-out', entry: expect.any(HTMLAnchorElement) });
    expect(state('<button>My account</button><div style="display:none"><button>Log in</button></div>').state).toBe('unknown');
    expect(state('<div hidden><a href="https://example.com/a">Log in</a><a href="https://example.com/b">Log in</a></div>').state).toBe('unknown');
    expect(state('<div hidden><a href="https://example.com/login">Log in</a><a href="/logout">Log out</a></div>').state).toBe('signed-in');
  });
  it('accepts an account menu that contains the sign-in link, as on AWS and Atlassian', () =>
    expect(state('<button>My account</button><a href="https://example.com/login">Sign in to console</a>').state).toBe('signed-out'));
  it('accepts repeated links to one destination and refuses different ones', () => {
    expect(state('<a href="https://example.com/login">Log in</a><footer><a href="https://example.com/login?from=footer">Log in</a></footer>')).toMatchObject({ entry: expect.any(HTMLElement) });
    expect(state('<a href="https://example.com/business">Log in</a><a href="https://example.com/personal">Log in</a>')).toEqual({ state: 'signed-out', entry: null });
  });
  it('ignores provider, registration and newsletter captions', () => {
    for (const label of ['Sign in with Google', 'Sign up', 'Log in to read more', 'Create account', 'Subscribe'])
      expect(state(`<button>${label}</button>`).state).toBe('unknown');
  });
});
