// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loginTargetFor } from './credential-form-analysis';
import { observeSignInStep } from './sign-in-step';
import { signInActionFor } from './sign-in-action';

const replaySource = readFileSync('scripts/replay-form-specimen.mjs', 'utf8').replaceAll('export function', 'function');
const replay = new Function(replaySource + '; return { hydrateFormSpecimen, querySpecimen };')() as {
  hydrateFormSpecimen(root: Element, css: string): void;
  querySpecimen(root: Document, selector: string): Element[];
};
const ROOT = 'tests/fixtures/forms';
// Reviewed by a person from the recorded captions, independently of the resolver.
const oracle = JSON.parse(readFileSync(`${ROOT}/sign-in-actions.json`, 'utf8')) as Record<string, { action: string | null; reason?: string }>;
const specimens = readdirSync(ROOT).filter(name => existsSync(`${ROOT}/${name}/case.json`))
  .map(name => ({ name, flow: JSON.parse(readFileSync(`${ROOT}/${name}/case.json`, 'utf8')) as { flow: string; topology?: string; source: { url: string } } }))
  .filter(({ flow }) => flow.topology !== 'cross-origin-child');

function mount(name: string): ReturnType<typeof loginTargetFor>[] {
  document.body.innerHTML = readFileSync(`${ROOT}/${name}/page.html`, 'utf8');
  const style = document.createElement('style');
  style.textContent = readFileSync(`${ROOT}/${name}/page.css`, 'utf8');
  document.head.append(style);
  replay.hydrateFormSpecimen(document.body, style.textContent);
  return (replay.querySpecimen(document, 'input') as HTMLInputElement[]).map(loginTargetFor).filter(target => target !== null);
}
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); });

describe('sign-in action on recorded login screens', () => {
  it('has a reviewed decision for every recorded login screen', () => {
    expect(Object.keys(oracle).sort()).toEqual(specimens.filter(item => item.flow.flow === 'login').map(item => item.name).sort());
  });
  for (const [name, { action }] of Object.entries(oracle)) it(name, () => {
    const targets = mount(name);
    expect(targets).toHaveLength(1);
    const expected = action === null ? null : replay.querySpecimen(document, action)[0];
    expect(expected).not.toBeUndefined();
    const found = signInActionFor(targets[0]!)?.element ?? null;
    expect(found?.outerHTML.slice(0, 160) ?? null).toBe(expected?.outerHTML.slice(0, 160) ?? null);
    expect(found).toBe(expected);
  });
});

// The recorded registration entry is the very same identifier page as sign-in.
const SHARED_IDENTIFIER_PAGES = ['20min', 'aftonbladet', 'bbc', 'finn', 'imdb', 'index-hr', 'pracuj', 'vg'];

describe('sign-in step on recorded registration screens', () => {
  for (const { name, flow } of specimens.filter(item => item.flow.flow === 'registration')) it(name, () => {
    mount(name);
    const step = observeSignInStep(document, flow.source.url);
    const shared = SHARED_IDENTIFIER_PAGES.some(service => name.startsWith(`${service}-registration`));
    expect(step.kind === 'identifier' || step.kind === 'login' ? step.action !== null : false).toBe(shared);
  });
});

describe('sign-in step on recorded login screens', () => {
  for (const { name, flow } of specimens.filter(item => item.flow.flow === 'login')) it(name, () => {
    mount(name);
    expect(['identifier', 'password', 'login']).toContain(observeSignInStep(document, flow.source.url).kind);
  });
});

describe('sign-in action refuses', () => {
  const html = (buttons: string) => {
    document.body.innerHTML = `<form method="post"><input type="email" autocomplete="username"><input type="password" autocomplete="current-password">${buttons}</form>`;
    const target = loginTargetFor(document.querySelector('input')!);
    expect(target).not.toBeNull();
    return signInActionFor(target!);
  };
  for (const label of ['Sign in with Google', 'Continue with Apple', 'Forgot password?', 'Create account', 'Log in with a passkey',
    'Log in with a one-time code', 'Use single sign-on', 'Zarejestruj się', 'Nie pamiętam hasła', 'Zaloguj się przez Facebook', 'Zaloguj za pomocą kodu QR'])
    it(`"${label}" as the only submit`, () => expect(html(`<button type="submit">${label}</button>`)).toBeNull());
  it('two equally plausible actions', () => expect(html('<button type="submit">Log in</button><button type="submit">Sign in</button>')).toBeNull());
  it('a visible caption that contradicts the accessible name', () =>
    expect(html('<button type="submit" aria-label="Log in">Sign in with Google</button>')).toBeNull());
  it('hidden actions', () => expect(html('<button type="submit" style="display:none">Log in</button>')).toBeNull());
  it('navigating links', () => expect(html('<a href="https://evil.example/">Log in</a>')).toBeNull());
  it('a page-header action before the form', () => {
    document.body.innerHTML = '<div><button type="button">Log in</button><form method="post"><input type="email" autocomplete="username"><input type="password" autocomplete="current-password"></form></div>';
    const target = [...document.querySelectorAll('input')].map(loginTargetFor).find(item => item !== null);
    expect(target).toBeTruthy();
    expect(signInActionFor(target!)).toBeNull();
  });
  it('reports a disabled action as not ready instead of choosing another one', () => {
    const found = html('<button type="submit" disabled>Log in</button><button type="button">Help</button>');
    expect(found).toMatchObject({ ready: false });
    expect(found!.element.textContent).toBe('Log in');
  });
});
