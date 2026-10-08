// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://accounts.example.test/"}
import { afterEach, describe, expect, it } from "vitest";
import { loginTargetFor, performFill, performLoginTargetFill } from "./fill";

const fields = [{ kind: "username", value: "fixture-user" }, { kind: "password", value: "fixture-password" }] as const;
afterEach(() => document.body.replaceChildren());

function mount(markup: string, shadow = false) {
  document.body.innerHTML = '<account-widget></account-widget>';
  const host = document.querySelector('account-widget')!;
  const root = shadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML = markup;
  return root;
}

describe("domain-independent login detection", () => {
  it.each([false, true])("fills a custom form with shadow=%s", (shadow) => {
    const root = mount('<vendor-form><input autocomplete="username webauthn"><input type="password" autocomplete="current-password"></vendor-form>', shadow);
    expect(loginTargetFor(root.querySelector('input')!)).not.toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect((root.querySelector('input[type=password]') as HTMLInputElement).value).toBe('fixture-password');
  });

  it.each(['name="email"', 'id="username"', 'aria-label="Username"', 'type="email"'])("recognizes a bounded pair using %s", (hint) => {
    const root = mount(`<div role="dialog"><div><input ${hint}></div><div><input type="password"></div></div>`);
    expect(loginTargetFor(root.querySelector('input')!)).not.toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: true });
  });

  it("uses an associated label", () => {
    const root = mount('<div><label for="identifier">Email address</label><input id="identifier"><input type="password"></div>');
    expect(loginTargetFor(root.querySelector('input')!)).not.toBeNull();
  });

  it.each([
    '<input autocomplete="username"><input type="password" autocomplete="new-password">',
    '<input autocomplete="username"><input type="password"><input type="password">',
    '<input autocomplete="username"><input autocomplete="username"><input type="password">',
    '<input name="search"><input type="password">',
    '<section><input autocomplete="username"></section><section><input type="password"></section>',
    '<div role="dialog"><input autocomplete="username"></div><div role="dialog"><input type="password"></div>',
    '<input autocomplete="one-time-code" name="username"><input type="password">',
    '<input autocomplete="username one-time-code"><input type="password">',
    '<input autocomplete="section-first username"><input type="password" autocomplete="section-second current-password">',
  ])("rejects ambiguous or unrelated fields without a permissive popup fallback: %s", (markup) => {
    const root = mount(`<div>${markup}</div>`);
    expect(loginTargetFor(root.querySelector('input')!)).toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: false, reason: "no-form" });
    expect([...root.querySelectorAll('input')].every(input => input.value === '')).toBe(true);
  });

  it("does not combine controls directly under body", () => {
    document.body.innerHTML = '<input autocomplete="username"><input type="password">';
    expect(loginTargetFor(document.querySelector('input')!)).toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: false, reason: "no-form" });
  });

  it("keeps a registration form separate from a login in the same dialog", () => {
    const root = mount('<div role="dialog"><section><input autocomplete="username"><input type="password" autocomplete="new-password"></section><section><input id="login" autocomplete="username"><input type="password" autocomplete="current-password"></section></div>');
    expect(loginTargetFor(root.querySelector('input')!)).toBeNull();
    expect(loginTargetFor(root.querySelector('#login')!)).not.toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect(root.querySelector('input')!.value).toBe('');
  });

  it("revalidates the pair after username input mutates the password", () => {
    const root = mount('<div><input autocomplete="username"><input type="password"></div>', true);
    const username = root.querySelector('input')!;
    const password = root.querySelector('input[type=password]') as HTMLInputElement;
    const target = loginTargetFor(username);
    expect(target).not.toBeNull();
    username.addEventListener('input', () => password.autocomplete = 'new-password');
    expect(performLoginTargetFill(target!, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(password.value).toBe('');
  });

  it("finds slotted controls inside a shadow form without duplicating candidates", () => {
    const root = mount('<input slot="user" autocomplete="username"><input slot="pass" type="password">');
    document.querySelector("account-widget")!.attachShadow({ mode: "open" }).innerHTML = '<div role="form"><slot name="user"></slot><slot name="pass"></slot></div>';
    expect(loginTargetFor(root.querySelector('input')!)).not.toBeNull();
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect((root.querySelector('input[type=password]') as HTMLInputElement).value).toBe('fixture-password');
  });
});
