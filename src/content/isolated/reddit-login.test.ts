// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.reddit.com/"}

import { afterEach, describe, expect, it, vi } from "vitest";
import { loginTargetFor, performFill, performLoginTargetFill } from "./fill";
import type { FillField } from "@shared/messaging";

declare const jsdom: { reconfigure(options: { url: string }): void };
const fields: FillField[] = [
  { kind: "username", value: "fixture-user" },
  { kind: "password", value: "fixture-password" },
];

import { mountRedditLogin as mount } from "../../../tests/fixtures/forms/reddit-login-2026-10-07/mount";

afterEach(() => {
  document.body.replaceChildren(); vi.unstubAllGlobals();
  jsdom.reconfigure({ url: "https://www.reddit.com/" });
});

describe("Reddit shadow login", () => {
  it("detects the pair and sends composed input events without submitting", () => {
    const { username, password, container } = mount();
    const changed = vi.fn();
    const clicked = vi.fn();
    container.addEventListener("input", changed);
    container.addEventListener("click", clicked);
    expect(document.querySelectorAll("input")).toHaveLength(0);
    const target = loginTargetFor(username);
    expect(target).toMatchObject({ username, password, sourceDocument: document });
    expect(performLoginTargetFill(target!, fields)).toEqual({ ok: true });
    expect(username.value).toBe("fixture-user");
    expect(password.value).toBe("fixture-password");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(clicked).not.toHaveBeenCalled();
  });

  it("fills the same pair from the popup", () => {
    const { username, password } = mount();
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect(username.value).toBe("fixture-user");
    expect(password.value).toBe("fixture-password");
  });

  it.each(["username", "password"] as const)("preserves an existing %s", (field) => {
    const controls = mount();
    controls[field].value = "already-entered";
    expect(performLoginTargetFill(loginTargetFor(controls.username)!, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(controls[field].value).toBe("already-entered");
    expect(controls[field === "username" ? "password" : "username"].value).toBe("");
  });

  it.each(["hidden", "inert", "aria-hidden", "style"])("rejects a password behind a %s host", (attribute) => {
    const { username, passwordHost } = mount();
    passwordHost.setAttribute(attribute, attribute === "style" ? "display:none" : "true");
    expect(loginTargetFor(username)?.password ?? null).toBeNull();
  });

  it("rechecks hidden ancestors and replaced controls immediately before filling", () => {
    const { username, password, passwordHost, container } = mount();
    const target = loginTargetFor(username);
    expect(target).not.toBeNull();
    container.hidden = true;
    expect(performLoginTargetFill(target!, fields)).toEqual({ ok: false, reason: "no-form" });
    container.hidden = false;
    password.replaceWith(password.cloneNode());
    expect(performLoginTargetFill(target!, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(passwordHost.shadowRoot!.querySelector("input")!.value).toBe("");
  });

  it("rejects ambiguous passwords and controls from different login containers", () => {
    const { username, password, passwordHost, root } = mount();
    password.after(password.cloneNode());
    expect(loginTargetFor(username)).toBeNull();
    password.nextElementSibling!.remove();
    const other = document.createElement("faceplate-form");
    other.id = "login";
    root.append(other);
    other.append(passwordHost);
    expect(loginTargetFor(username)?.password ?? null).toBeNull();
  });

  it("withholds the password if the page hides its host during the username input event", () => {
    const { username, password, passwordHost, container } = mount();
    const target = loginTargetFor(username);
    expect(target).not.toBeNull();
    container.addEventListener("input", () => passwordHost.setAttribute("hidden", ""), { once: true });
    expect(performLoginTargetFill(target!, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(username.value).toBe("fixture-user");
    expect(password.value).toBe("");
  });

  it.each(["https://other.reddit.com/", "https://example.test/"])(
    "recognizes the same structure without a domain exception on %s", (url) => {
      const { username } = mount();
      jsdom.reconfigure({ url });
      expect(loginTargetFor(username)).not.toBeNull();
    },
  );

});
