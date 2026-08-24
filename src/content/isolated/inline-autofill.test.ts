// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  displayEntryLabel,
  isLoginField,
  startInlineAutofill,
  suggestionDetail,
} from "./inline-autofill";
import { submitLoginForm } from "./fill";

beforeEach(() => {
  Object.assign(globalThis, {
    chrome: {
      runtime: { sendMessage: vi.fn() },
      storage: { local: { get: vi.fn(async () => ({})) } },
      i18n: { getUILanguage: () => "en" },
    },
  });
  Object.defineProperty(window.navigator, "userActivation", {
    configurable: true,
    value: { isActive: true },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "userActivation");
  document.body.replaceChildren();
  for (const host of document.querySelectorAll("palladin-autofill")) host.remove();
});

describe("inline autofill field discovery", () => {
  it("labels the vault explicitly and does not repeat an entry name that is the domain", () => {
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "allegro.pl",
      username: "rogal_s_days",
      vaultName: "TMo 10",
      urlDomain: "allegro.pl",
      match: "exact" as const,
    };

    expect(displayEntryLabel(suggestion)).toBeNull();
    expect(suggestionDetail(suggestion, "en")).toBe("Vault: TMo 10");
    expect(suggestionDetail(suggestion, "pl")).toBe("Sejf: TMo 10");
  });

  it("keeps a distinct entry label and identifies a related host", () => {
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "WP account",
      username: "ada@wp.pl",
      vaultName: "Personal",
      urlDomain: "1login.wp.pl",
      match: "related" as const,
    };

    expect(displayEntryLabel(suggestion)).toBe("WP account");
    expect(suggestionDetail(suggestion, "en"))
      .toBe("Related site: 1login.wp.pl · Vault: Personal");
  });

  it("submits only the form owning the launcher field", () => {
    document.body.innerHTML = `
      <form id="login"><input id="username"><button id="submit" type="submit">Go</button></form>
      <form id="other"><button type="submit">Other</button></form>
    `;
    const login = document.querySelector("#login") as HTMLFormElement;
    const submit = document.querySelector("#submit") as HTMLButtonElement;
    const requestSubmit = vi.spyOn(login, "requestSubmit").mockImplementation(() => undefined);

    expect(submitLoginForm(document.querySelector("#username") as HTMLInputElement)).toBe(true);
    expect(requestSubmit).toHaveBeenCalledWith(submit);
  });

  it("shows one launcher on the username control, not on password or unrelated text", () => {
    document.body.innerHTML = `
      <form><input id="username" type="email"><input id="password" type="password"></form>
      <input id="search" type="text">
    `;
    expect(isLoginField(document.querySelector("#username") as HTMLInputElement)).toBe(true);
    expect(isLoginField(document.querySelector("#password") as HTMLInputElement)).toBe(false);
    expect(isLoginField(document.querySelector("#search") as HTMLInputElement)).toBe(false);
  });

  it("ignores a standalone email form even when autocomplete identifies the field", async () => {
    document.body.innerHTML = `
      <form><input id="email" type="email" autocomplete="email"></form>
    `;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));

    expect(isLoginField(document.querySelector("#email") as HTMLInputElement)).toBe(false);
    const subject = startInlineAutofill(document, "a".repeat(32), send);
    await Promise.resolve();

    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("does not pair an email field with a password owned by another form", () => {
    document.body.innerHTML = `
      <form id="email-form"><input id="email" type="email" autocomplete="username"></form>
      <form id="password-form"><input type="password"></form>
    `;

    expect(isLoginField(document.querySelector("#email") as HTMLInputElement)).toBe(false);
  });

  it("ignores a login pair while either control is not usable", () => {
    document.body.innerHTML = `
      <form>
        <input id="hidden-username" type="email" hidden>
        <input id="hidden-password" type="password" hidden>
      </form>
    `;
    const username = document.querySelector("#hidden-username") as HTMLInputElement;
    const password = document.querySelector("#hidden-password") as HTMLInputElement;

    expect(isLoginField(username)).toBe(false);
    username.hidden = false;
    expect(isLoginField(username)).toBe(false);
    password.hidden = false;
    expect(isLoginField(username)).toBe(true);
  });

  it("rejects a login pair hidden by page CSS and tracks ancestor visibility changes", async () => {
    const style = document.createElement("style");
    style.textContent = ".page-hidden { display: none; }";
    document.head.append(style);
    document.body.innerHTML = `
      <section id="container" class="page-hidden">
        <form><input id="username" type="email"><input type="password"></form>
      </section>
    `;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const username = document.querySelector("#username") as HTMLInputElement;
    const container = document.querySelector("#container") as HTMLElement;
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    try {
      expect(isLoginField(username)).toBe(false);
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();

      container.classList.remove("page-hidden");
      await vi.waitFor(() => {
        expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
      });

      container.classList.add("page-hidden");
      await vi.waitFor(() => {
        expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
      });
    } finally {
      subject.stop();
      style.remove();
    }
  });

  it("rescans rendered control geometry after a viewport resize", async () => {
    document.body.innerHTML = `
      <form><input id="username" type="email"><input type="password"></form>
    `;
    const username = document.querySelector("#username") as HTMLInputElement;
    let collapsed = true;
    vi.spyOn(username, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
    vi.spyOn(username, "getBoundingClientRect").mockImplementation(() => ({
      x: 20,
      y: 40,
      left: 20,
      top: 40,
      right: collapsed ? 20 : 320,
      bottom: collapsed ? 40 : 80,
      width: collapsed ? 0 : 300,
      height: collapsed ? 0 : 40,
      toJSON: () => ({}),
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    })));

    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    collapsed = false;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    });

    collapsed = true;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    });
    subject.stop();
  });

  it("tracks dynamic input form association and owning form id changes", async () => {
    document.body.innerHTML = `
      <form id="login"><input type="password"></form>
      <input id="username" type="email">
    `;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const username = document.querySelector("#username") as HTMLInputElement;
    const form = document.querySelector("#login") as HTMLFormElement;
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    username.setAttribute("form", "login");
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    });

    form.id = "renamed";
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    });

    username.setAttribute("form", "renamed");
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    });
    subject.stop();
  });

  it("tracks effective disabled state inherited from a fieldset", async () => {
    document.body.innerHTML = `
      <form><fieldset id="controls" disabled>
        <input type="email"><input type="password">
      </fieldset></form>
    `;
    const fieldset = document.querySelector("#controls") as HTMLFieldSetElement;
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    })));

    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    fieldset.disabled = false;
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    });

    fieldset.disabled = true;
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    });
    subject.stop();
  });

  it("tracks a login dialog opening and closing", async () => {
    document.body.innerHTML = `
      <dialog id="login"><form>
        <input type="email"><input type="password">
      </form></dialog>
    `;
    const dialog = document.querySelector("#login") as HTMLDialogElement;
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    })));

    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    dialog.setAttribute("open", "");
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    });

    dialog.removeAttribute("open");
    await vi.waitFor(() => {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
    });
    subject.stop();
  });

  it("mounts isolated launchers and removes them on stop", async () => {
    document.body.innerHTML = `<form><input type="email"><input type="password"></form>`;
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    })));
    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
    subject.stop();
    expect(document.querySelectorAll("palladin-autofill")).toHaveLength(0);
  });

  it("fills the only exact-host login when the form appears", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async (command: { type: string }) => command.type === "inline/list" ? ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{
        vaultId: "v1",
        entryId: "e1",
        name: "Work",
        username: "ada@example.com",
        vaultName: "Personal",
        urlDomain: "example.com",
        match: "exact",
      }],
    }) : ({ ok: true, kind: "fill", status: "filled" }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      vaultId: "v1",
      entryId: "e1",
      loginTargetId: expect.stringMatching(/^login-\d+$/),
    })));
    subject.stop();
  });

  it("fills the first preferred exact-host account when several match", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: { type: string }) => command.type === "inline/list" ? ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [suggestion, { ...suggestion, entryId: "e2", username: "grace@example.com" }],
    }) : ({ ok: true, kind: "fill", status: "filled" }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      vaultId: "v1",
      entryId: "e1",
      scope: "exact",
    })));
    subject.stop();
  });

  it("retries automatic fill after the unlocked Vault index becomes ready", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    let ready = false;
    const send = vi.fn(async (command: { type: string }) => command.type === "inline/list" ? ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: ready ? [suggestion] : [],
    }) : ({ ok: true, kind: "fill", status: "filled" }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/list",
    })));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));

    ready = true;
    subject.invalidateSuggestions();
    subject.retryAutomaticFill();

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      entryId: "e1",
      scope: "exact",
    })));
    subject.stop();
  });

  it("does not retain a completed plaintext suggestion response", async () => {
    document.body.innerHTML = `<form><input autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    subject.retryAutomaticFill();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    subject.stop();
  });

  it("does not repeat automatic fills when the page refocuses the same form", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: { type: string }) => command.type === "inline/list" ? ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [suggestion],
    }) : ({ ok: true, kind: "fill", status: "filled" }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);
    const input = document.querySelector("#username") as HTMLInputElement;

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      entryId: "e1",
    })));
    input.focus();
    input.blur();
    input.focus();
    await Promise.resolve();
    expect(send.mock.calls.filter(([command]) => command.type === "inline/fill")).toHaveLength(1);
    subject.stop();
  });

  it("auto-fills an exact-host form without requiring focus or a user gesture", async () => {
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{
        vaultId: "v1",
        entryId: "e1",
        name: "Work",
        username: "ada@example.com",
        vaultName: "Personal",
        urlDomain: "example.com",
        match: "exact",
      }],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      entryId: "e1",
      scope: "exact",
    })));
    subject.stop();
  });

  it.each([
    ["locked", "Palladin is locked", "Unlock Palladin"],
    ["signed-out", "Sign in to Palladin to fill this login", "Sign in to Palladin"],
  ] as const)("opens the %s session prompt automatically on a login form", async (
    status,
    expectedMessage,
    expectedAction,
  ) => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
    document.body.innerHTML = `<form><input autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status,
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    try {
      await vi.waitFor(() => {
        const root = document.querySelector("palladin-autofill")?.shadowRoot;
        expect(root?.textContent).toContain(expectedMessage);
        expect(root?.querySelector(".panel")?.hasAttribute("hidden")).toBe(false);
        expect(root?.querySelector(".open-palladin")?.textContent).toBe(expectedAction);
      });
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it("does not overwrite a field changed while the preferred login is loading", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    let resolveList: ((value: unknown) => void) | null = null;
    const send = vi.fn((command: { type: string }) => command.type === "inline/list"
      ? new Promise((resolve) => { resolveList = resolve; })
      : Promise.resolve({ ok: true, kind: "fill", status: "filled" }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);
    const input = document.querySelector("#username") as HTMLInputElement;
    input.value = "typed-by-user";
    if (resolveList === null) throw new Error("list request was not started");
    (resolveList as (value: unknown) => void)({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{
        vaultId: "v1",
        entryId: "e1",
        name: "Work",
        username: "ada@example.com",
        vaultName: "Personal",
        urlDomain: "example.com",
        match: "exact",
      }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    subject.stop();
  });

  it("never auto-fills a sole related-host suggestion", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [{
        vaultId: "v1",
        entryId: "e1",
        name: "WP",
        username: "ada@wp.pl",
        vaultName: "Personal",
        urlDomain: "1login.wp.pl",
        match: "related",
      }],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    subject.stop();
  });

  it("pins Palladin typography and aligns the launcher to the control height", () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username" style="padding-right:30px"><input type="password"></form>`;
    const input = document.querySelector("#username") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: 20, y: 40, left: 20, top: 40, right: 420, bottom: 88,
      width: 400, height: 48, toJSON: () => ({}),
    });
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true, kind: "suggestions", status: "ready", entries: [],
    })));
    const host = document.querySelector("palladin-autofill") as HTMLElement;
    expect(host.style.getPropertyValue("font-family")).toContain("system-ui");
    expect(host.style.getPropertyPriority("font-family")).toBe("important");
    expect(host.style.getPropertyValue("pointer-events")).toBe("none");
    expect(host.style.getPropertyPriority("pointer-events")).toBe("important");
    expect(host.style.left).toBe("383px");
    subject.stop();
  });
});
