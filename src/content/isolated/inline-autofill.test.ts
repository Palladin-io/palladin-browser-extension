// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://example.com/login" }

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineAutofillCommand } from "@shared/messaging";
import {
  displayEntryLabel,
  isClosedSurfaceUserIntent,
  isClosedSurfaceLauncherGesture,
  isLoginField,
  isTransientFieldUserIntent,
  startInlineAutofill,
  suggestionDetail,
  type InlineUserIntentVerifier,
} from "./inline-autofill";
import { OneShotInlineFillCapabilities, performBoundFill } from "./fill";

const DIRECT_USER_INTENT: InlineUserIntentVerifier = {
  field: (_event, input) => input.ownerDocument.activeElement === input,
  closedSurface: () => true,
};

const VISUAL_SURFACE_USER_INTENT: InlineUserIntentVerifier = {
  field: DIRECT_USER_INTENT.field,
  closedSurface: (event, surface) => surface === undefined
    || isClosedSurfaceLauncherGesture(event, surface),
};

const VISIBLE_RECT: DOMRect = {
  x: 20,
  y: 40,
  left: 20,
  top: 40,
  right: 420,
  bottom: 88,
  width: 400,
  height: 48,
  toJSON: () => ({}),
};
let nativeGetComputedStyle: (element: Element) => CSSStyleDeclaration;
let emptyPseudoStyle: CSSStyleDeclaration;

function clickActiveField(input: HTMLInputElement): void {
  input.focus();
  const rect = input.getBoundingClientRect();
  input.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
}

function launcherRectFor(input: HTMLInputElement): DOMRect {
  const inputRect = input.getBoundingClientRect();
  const edgeGap = Math.min(18, Math.max(8, (inputRect.height - 26) / 2));
  const left = Math.max(4, inputRect.right - 26 - edgeGap);
  const top = Math.max(4, inputRect.top + (inputRect.height - 26) / 2);
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + 26,
    bottom: top + 26,
    width: 26,
    height: 26,
    toJSON: () => ({}),
  };
}

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
  nativeGetComputedStyle = window.getComputedStyle.bind(window);
  emptyPseudoStyle = document.createElement("span").style;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => (
    pseudo === undefined || pseudo === null || pseudo === ""
      ? nativeGetComputedStyle(element)
      : emptyPseudoStyle
  ));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const controls = [...document.querySelectorAll("input, textarea")];
    const index = controls.indexOf(this);
    if (this.localName === "palladin-autofill") {
      const hosts = [...document.querySelectorAll("palladin-autofill")];
      const loginInputs = [...document.querySelectorAll<HTMLInputElement>("input")]
        .filter((input) => isLoginField(input));
      const input = loginInputs[hosts.indexOf(this)];
      if (input !== undefined) {
        const inputRect = input.getBoundingClientRect();
        const edgeGap = Math.min(18, Math.max(8, (inputRect.height - 26) / 2));
        const left = Math.max(4, inputRect.right - 26 - edgeGap);
        const top = Math.max(4, inputRect.top + (inputRect.height - 26) / 2);
        return {
          ...VISIBLE_RECT,
          x: left,
          y: top,
          left,
          top,
          right: left + 26,
          bottom: top + 26,
          width: 26,
          height: 26,
        };
      }
    }
    if (index < 0) {
      return {
        ...VISIBLE_RECT,
        x: 800,
        y: 700,
        left: 800,
        top: 700,
        right: 840,
        bottom: 740,
        width: 40,
        height: 40,
      };
    }
    const top = 40 + index * 60;
    return { ...VISIBLE_RECT, y: top, top, bottom: top + VISIBLE_RECT.height };
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((x: number, y: number) => [...document.querySelectorAll<HTMLElement>("input, textarea")]
      .find((element) => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) ?? null),
  });
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "userActivation");
  document.body.replaceChildren();
  for (const host of document.querySelectorAll("palladin-autofill")) host.remove();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
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

  it("shows one launcher on the username control, not on password or unrelated text", () => {
    document.body.innerHTML = `
      <form><input id="username" type="email"><input id="password" type="password"></form>
      <input id="search" type="text">
    `;
    expect(isLoginField(document.querySelector("#username") as HTMLInputElement)).toBe(true);
    expect(isLoginField(document.querySelector("#password") as HTMLInputElement)).toBe(false);
    expect(isLoginField(document.querySelector("#search") as HTMLInputElement)).toBe(false);
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

  it("does not load or fill credentials when a passive scan finds a form", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("fills the preferred exact-host account only after direct intent on the active field", async () => {
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
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    const input = document.querySelector("#username") as HTMLInputElement;

    expect(send).not.toHaveBeenCalled();
    clickActiveField(input);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
      vaultId: "v1",
      entryId: "e1",
      scope: "exact",
    })));
    subject.stop();
  });

  it("binds a field click to that exact form when two visible login forms exist", async () => {
    document.body.innerHTML = `
      <form id="a"><input id="user-a" autocomplete="username"><input id="pass-a" type="password"></form>
      <form id="b"><input id="user-b" autocomplete="username"><input id="pass-b" type="password"></form>
    `;
    const capabilities = new OneShotInlineFillCapabilities();
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: InlineAutofillCommand): Promise<unknown> => {
      if (command.type === "inline/list") {
        return { ok: true, kind: "suggestions", status: "ready", entries: [suggestion] };
      }
      if (command.type !== "inline/fill") return { ok: false, code: "unsupported" };
      const outcome = performBoundFill(document, {
        channel: "palladin.fill/request",
        documentId: command.documentId,
        expectedOrigin: "https://example.com",
        expectedDomain: "example.com",
        capabilityId: command.capabilityId,
        submit: command.submit,
        fields: [
          { kind: "username", value: "ada@example.com" },
          { kind: "password", value: "bound-secret" },
        ],
      }, "https://example.com/login", command.documentId, capabilities);
      return {
        ok: true,
        kind: "fill",
        status: outcome.ok ? "filled" : outcome.reason === "no-form" ? "no-form" : "blocked",
      };
    });
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
      capabilities,
    );
    const userB = document.querySelector("#user-b") as HTMLInputElement;

    clickActiveField(userB);

    await vi.waitFor(() => expect(userB.value).toBe("ada@example.com"));
    expect((document.querySelector("#pass-b") as HTMLInputElement).value).toBe("bound-secret");
    expect((document.querySelector("#user-a") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#pass-a") as HTMLInputElement).value).toBe("");
    subject.stop();
  });

  it("ignores a legitimately non-painting hidden widget while filling a visible form", () => {
    document.body.innerHTML = `
      <form id="responsive-hidden"><input id="hidden-user" autocomplete="username"><input type="password"></form>
      <form id="visible"><input id="visible-user" autocomplete="username"><input id="visible-pass" type="password"></form>
    `;
    const hiddenUser = document.querySelector("#hidden-user") as HTMLInputElement;
    vi.spyOn(hiddenUser, "getBoundingClientRect").mockReturnValue({
      ...VISIBLE_RECT,
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
    const capabilities = new OneShotInlineFillCapabilities();
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      async () => ({ ok: true, kind: "suggestions", status: "ready", entries: [] }),
      DIRECT_USER_INTENT,
      capabilities,
    );
    const visibleUser = document.querySelector("#visible-user") as HTMLInputElement;
    const capabilityId = capabilities.issue(visibleUser);
    if (capabilityId === null) throw new Error("visible capability was not issued");

    expect(performBoundFill(document, {
      channel: "palladin.fill/request",
      documentId: "a".repeat(32),
      expectedOrigin: "https://example.com",
      expectedDomain: "example.com",
      capabilityId,
      submit: false,
      fields: [
        { kind: "username", value: "ada@example.com" },
        { kind: "password", value: "visible-secret" },
      ],
    }, "https://example.com/login", "a".repeat(32), capabilities)).toEqual({ ok: true });
    expect(visibleUser.value).toBe("ada@example.com");
    expect((document.querySelector("#visible-pass") as HTMLInputElement).value).toBe("visible-secret");
    subject.stop();
  });

  it("snapshots form B in capture before an earlier page bubble handler retargets it to form A", async () => {
    document.body.innerHTML = `
      <form id="a"><input id="user-a" autocomplete="username"><input id="pass-a" type="password"></form>
      <form id="b"><input id="user-b" autocomplete="username"><input id="pass-b" type="password"></form>
    `;
    const userB = document.querySelector("#user-b") as HTMLInputElement;
    // Registered before Palladin to reproduce a page handler that beat the old
    // target-level bubble listener. Delegated window capture must still bind B.
    userB.addEventListener("click", () => userB.setAttribute("form", "a"));
    const capabilities = new OneShotInlineFillCapabilities();
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: InlineAutofillCommand): Promise<unknown> => {
      if (command.type === "inline/list") {
        return { ok: true, kind: "suggestions", status: "ready", entries: [suggestion] };
      }
      if (command.type !== "inline/fill") return { ok: false, code: "unsupported" };
      const outcome = performBoundFill(document, {
        channel: "palladin.fill/request",
        documentId: command.documentId,
        expectedOrigin: "https://example.com",
        expectedDomain: "example.com",
        capabilityId: command.capabilityId,
        submit: command.submit,
        fields: [
          { kind: "username", value: "must-not-write" },
          { kind: "password", value: "must-not-write" },
        ],
      }, "https://example.com/login", command.documentId, capabilities);
      return {
        ok: true,
        kind: "fill",
        status: outcome.ok ? "filled" : outcome.reason === "no-form" ? "no-form" : "blocked",
      };
    });
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
      capabilities,
    );

    clickActiveField(userB);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
    })));
    expect(userB.form?.id).toBe("a");
    expect((document.querySelector("#user-a") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#pass-a") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#pass-b") as HTMLInputElement).value).toBe("");
    subject.stop();
  });

  it("rejects the inline capability when the page mutates the form after inline/fill", async () => {
    document.body.innerHTML = `
      <form id="login"><input id="username" autocomplete="username"><input id="password" type="password"></form>
    `;
    const capabilities = new OneShotInlineFillCapabilities();
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: InlineAutofillCommand): Promise<unknown> => {
      if (command.type === "inline/list") {
        return { ok: true, kind: "suggestions", status: "ready", entries: [suggestion] };
      }
      if (command.type !== "inline/fill") return { ok: false, code: "unsupported" };
      document.querySelector("#login")!.innerHTML = `
        <input id="replacement-user" autocomplete="username">
        <input id="replacement-pass" type="password">
      `;
      await Promise.resolve();
      const outcome = performBoundFill(document, {
        channel: "palladin.fill/request",
        documentId: command.documentId,
        expectedOrigin: "https://example.com",
        expectedDomain: "example.com",
        capabilityId: command.capabilityId,
        submit: command.submit,
        fields: [
          { kind: "username", value: "ada@example.com" },
          { kind: "password", value: "must-not-write" },
        ],
      }, "https://example.com/login", command.documentId, capabilities);
      return {
        ok: true,
        kind: "fill",
        status: outcome.ok ? "filled" : outcome.reason === "no-form" ? "no-form" : "blocked",
      };
    });
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
      capabilities,
    );

    clickActiveField(document.querySelector("#username") as HTMLInputElement);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "inline/fill",
    })));
    await vi.waitFor(() => {
      expect((document.querySelector("#replacement-user") as HTMLInputElement).value).toBe("");
      expect((document.querySelector("#replacement-pass") as HTMLInputElement).value).toBe("");
    });
    subject.stop();
  });

  it("does not authorize transparent or hit-test-occluded field clicks", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    const input = document.querySelector("#username") as HTMLInputElement;

    input.style.opacity = "0";
    clickActiveField(input);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    input.style.opacity = "1";
    const overlay = document.createElement("div");
    document.body.append(overlay);
    vi.mocked(document.elementFromPoint).mockReturnValue(overlay);
    clickActiveField(input);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("does not authorize a field covered by an opaque pointer-transparent body pseudo-element", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const pseudoStyle = document.createElement("span").style;
    pseudoStyle.content = '""';
    pseudoStyle.display = "block";
    pseudoStyle.position = "fixed";
    pseudoStyle.pointerEvents = "none";
    pseudoStyle.inset = "0";
    pseudoStyle.backgroundColor = "rgb(0, 0, 0)";
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === document.body && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);

    clickActiveField(document.querySelector("#username") as HTMLInputElement);
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("does not trust generated paint attached to the authentic extension host", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
    );
    const input = document.querySelector("#username") as HTMLInputElement;
    const authenticHost = document.querySelector("palladin-autofill") as HTMLElement;
    const pseudoStyle = document.createElement("span").style;
    pseudoStyle.content = '""';
    pseudoStyle.display = "block";
    pseudoStyle.position = "fixed";
    pseudoStyle.pointerEvents = "none";
    pseudoStyle.inset = "0";
    pseudoStyle.backgroundColor = "rgb(0, 0, 0)";
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === authenticHost && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });

    clickActiveField(input);
    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("does not trust outbound inline paint added to the authentic extension host", async () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
    );
    const input = document.querySelector("#username") as HTMLInputElement;
    const authenticHost = document.querySelector("palladin-autofill") as HTMLElement;
    authenticHost.style.setProperty(
      "outline",
      "1000px solid rgb(20, 30, 40)",
      "important",
    );

    clickActiveField(input);
    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("never fills from invalidation or passive retry work", async () => {
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

    subject.invalidateSuggestions();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("does not retain a completed plaintext suggestion response between direct intents", async () => {
    document.body.innerHTML = `<form><input autocomplete="username"><input type="password"></form>`;
    const send = vi.fn(async () => ({
      ok: true,
      kind: "suggestions",
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    const input = document.querySelector("input") as HTMLInputElement;

    clickActiveField(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    clickActiveField(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    subject.stop();
  });

  it("does not fill when the page programmatically refocuses the form", async () => {
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

    input.focus();
    input.blur();
    input.focus();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("rejects an untrusted field click without transient user activation", async () => {
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
    const input = document.querySelector("#username") as HTMLInputElement;
    clickActiveField(input);

    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    subject.stop();
  });

  it("requires transient activation and the exact active field even for a trusted event", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const trustedEvent = { isTrusted: true } as Event;
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    expect(isTransientFieldUserIntent(trustedEvent, input)).toBe(false);

    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    expect(isTransientFieldUserIntent(trustedEvent, input)).toBe(true);
    document.body.focus();
    input.blur();
    expect(isTransientFieldUserIntent(trustedEvent, input)).toBe(false);
  });

  it("requires transient activation for a trusted closed-surface click", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const trustedEvent = { isTrusted: true, currentTarget: button } as unknown as Event;
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    expect(isClosedSurfaceUserIntent(trustedEvent)).toBe(false);
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    expect(isClosedSurfaceUserIntent(trustedEvent)).toBe(true);
  });

  it("requires exact launcher geometry, host integrity, and page/shadow hit tests", () => {
    const input = document.createElement("input");
    input.autocomplete = "username";
    const password = document.createElement("input");
    password.type = "password";
    const form = document.createElement("form");
    form.append(input, password);
    document.body.append(form);
    const host = document.createElement("palladin-autofill");
    for (const [property, value] of [
      ["all", "initial"],
      ["font-family", 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
      ["font-size", "16px"],
      ["line-height", "1.4"],
      ["font-synthesis", "none"],
      ["position", "fixed"],
      ["z-index", "2147483647"],
      ["width", "26px"],
      ["height", "26px"],
      ["display", "block"],
      ["left", "383px"],
      ["top", "51px"],
    ] as const) host.style.setProperty(property, value, "important");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadow.append(button);
    document.documentElement.append(host);
    const launcherRect = {
      ...VISIBLE_RECT,
      x: 383,
      y: 51,
      left: 383,
      top: 51,
      right: 409,
      bottom: 77,
      width: 26,
      height: 26,
    };
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(launcherRect);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(launcherRect);
    Object.defineProperty(shadow, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => button),
    });

    const checkPointer = (): boolean => {
      let result = false;
      window.addEventListener("pointerdown", (event) => {
        result = isClosedSurfaceLauncherGesture(event, { host, button, shadow, input });
      }, { capture: true, once: true });
      button.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        composed: true,
        clientX: launcherRect.left + 4,
        clientY: launcherRect.top + 4,
      }));
      return result;
    };

    vi.mocked(document.elementFromPoint).mockReturnValue(host);
    expect(checkPointer()).toBe(true);
    // Real Chromium returns an empty `getPropertyValue("all")` after the later
    // longhands are assigned. The verifier is intentionally longhand/computed.
    host.style.removeProperty("all");
    expect(checkPointer()).toBe(true);

    input.focus();
    input.style.outline = "5px auto -webkit-focus-ring-color";
    expect(checkPointer()).toBe(true);
    input.style.outline = "1000px auto -webkit-focus-ring-color";
    expect(checkPointer()).toBe(false);
    input.style.outline = "5px auto -webkit-focus-ring-color";
    input.style.outlineOffset = "1000px";
    expect(checkPointer()).toBe(false);
    input.style.removeProperty("outline");
    input.style.removeProperty("outline-offset");

    for (const [property, value] of [
      ["outline", "1000px solid rgb(20, 30, 40)"],
      ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
      ["text-shadow", "0 0 1000px rgb(20, 30, 40)"],
      ["filter", "drop-shadow(0 0 1000px rgb(20, 30, 40))"],
    ] as const) {
      input.style.setProperty(property, value);
      expect(checkPointer()).toBe(false);
      input.style.removeProperty(property);
    }

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.zIndex = "2147483647";
    overlay.style.pointerEvents = "none";
    overlay.style.backgroundColor = "rgb(20, 30, 40)";
    overlay.style.outline = "1000px solid rgb(20, 30, 40)";
    overlay.style.outline = "1000px solid rgb(20, 30, 40)";
    document.body.append(overlay);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(launcherRect);
    // Chrome omits pointer-transparent paint from both hit tests.
    expect(checkPointer()).toBe(false);
    overlay.remove();

    const outboundOverlay = document.createElement("div");
    outboundOverlay.style.pointerEvents = "none";
    outboundOverlay.style.outline = "1000px solid rgb(20, 30, 40)";
    document.body.append(outboundOverlay);
    vi.spyOn(outboundOverlay, "getBoundingClientRect").mockReturnValue({
      ...launcherRect,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    expect(checkPointer()).toBe(false);
    outboundOverlay.remove();

    for (const [property, value] of [
      ["outline", "1000px solid rgb(20, 30, 40)"],
      ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
    ] as const) {
      const autoPointerOverlay = document.createElement("div");
      autoPointerOverlay.style.pointerEvents = "auto";
      autoPointerOverlay.style.setProperty(property, value);
      document.body.append(autoPointerOverlay);
      vi.spyOn(autoPointerOverlay, "getBoundingClientRect").mockReturnValue({
        ...launcherRect,
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 11,
        bottom: 11,
        width: 1,
        height: 1,
      });
      // Chromium keeps outbound paint outside the auto-pointer element's
      // hit-test box and still reports the authentic launcher host.
      expect(checkPointer()).toBe(false);
      autoPointerOverlay.remove();
    }

    const pageShadowHost = document.createElement("div");
    const pageShadow = pageShadowHost.attachShadow({ mode: "open" });
    const shadowOverlay = document.createElement("div");
    shadowOverlay.style.pointerEvents = "none";
    shadowOverlay.style.outline = "1000px solid rgb(20, 30, 40)";
    pageShadow.append(shadowOverlay);
    document.body.append(pageShadowHost);
    vi.spyOn(shadowOverlay, "getBoundingClientRect").mockReturnValue({
      ...launcherRect,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    expect(checkPointer()).toBe(false);
    pageShadowHost.remove();

    for (const [property, value] of [
      ["outline", "1000px solid rgb(20, 30, 40)"],
      ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
    ] as const) {
      const autoShadowHost = document.createElement("div");
      const autoShadow = autoShadowHost.attachShadow({ mode: "open" });
      const autoShadowOverlay = document.createElement("div");
      autoShadowOverlay.style.pointerEvents = "auto";
      autoShadowOverlay.style.setProperty(property, value);
      autoShadow.append(autoShadowOverlay);
      document.body.append(autoShadowHost);
      vi.spyOn(autoShadowOverlay, "getBoundingClientRect").mockReturnValue({
        ...launcherRect,
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 11,
        bottom: 11,
        width: 1,
        height: 1,
      });
      expect(checkPointer()).toBe(false);
      autoShadowHost.remove();
    }

    const pseudoStyle = document.createElement("span").style;
    pseudoStyle.content = '""';
    pseudoStyle.display = "block";
    pseudoStyle.position = "fixed";
    pseudoStyle.pointerEvents = "none";
    pseudoStyle.inset = "0";
    pseudoStyle.backgroundColor = "rgb(0, 0, 0)";
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === document.body && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });
    expect(checkPointer()).toBe(false);
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => (
      pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle
    ));

    for (const content of ['url("data:image/png;base64,AA==")', "counter(item)"]) {
      const nonTextPseudo = document.createElement("span").style;
      nonTextPseudo.content = content;
      nonTextPseudo.display = "block";
      nonTextPseudo.position = "fixed";
      nonTextPseudo.pointerEvents = "none";
      nonTextPseudo.color = "transparent";
      nonTextPseudo.opacity = "1";
      nonTextPseudo.visibility = "visible";
      vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
        if (element === document.body && pseudo === "::after") return nonTextPseudo;
        return pseudo === undefined || pseudo === null || pseudo === ""
          ? nativeGetComputedStyle(element)
          : emptyPseudoStyle;
      });
      expect(checkPointer()).toBe(false);
    }
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => (
      pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle
    ));

    for (const [property, value] of [
      ["outline", "1000px solid rgb(20, 30, 40)"],
      ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
    ] as const) {
      const outboundPseudo = document.createElement("span").style;
      outboundPseudo.content = '""';
      outboundPseudo.display = "block";
      outboundPseudo.position = "static";
      outboundPseudo.pointerEvents = "auto";
      outboundPseudo.setProperty(property, value);
      outboundPseudo.opacity = "1";
      outboundPseudo.visibility = "visible";
      vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
        if (element === document.body && pseudo === "::before") return outboundPseudo;
        return pseudo === undefined || pseudo === null || pseudo === ""
          ? nativeGetComputedStyle(element)
          : emptyPseudoStyle;
      });
      expect(checkPointer()).toBe(false);
    }
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => (
      pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle
    ));

    host.style.setProperty("outline", "1000px solid rgb(20, 30, 40)", "important");
    expect(checkPointer()).toBe(false);
    host.style.removeProperty("outline");

    host.style.setProperty("opacity", "0", "important");
    expect(checkPointer()).toBe(false);
    host.style.removeProperty("opacity");

    vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    expect(checkPointer()).toBe(false);

    vi.mocked(document.elementFromPoint).mockReturnValue(host);
    host.style.setProperty("width", "100vw", "important");
    expect(checkPointer()).toBe(false);
  });

  it.each([
    ["locked", "Palladin is locked", "Unlock Palladin"],
    ["signed-out", "Sign in to Palladin to fill this login", "Sign in to Palladin"],
  ] as const)("opens the %s session prompt only after direct field intent", async (
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
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    clickActiveField(document.querySelector("input") as HTMLInputElement);

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
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    const input = document.querySelector("#username") as HTMLInputElement;
    clickActiveField(input);
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

  it("never selects a sole related-host suggestion from field intent", async () => {
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
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);
    clickActiveField(document.querySelector("#username") as HTMLInputElement);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    subject.stop();
  });

  it("fills a selected account after a direct click in the closed extension surface", async () => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
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
    const subject = startInlineAutofill(document, "a".repeat(32), send, DIRECT_USER_INTENT);

    try {
      const root = document.querySelector("palladin-autofill")?.shadowRoot;
      (root?.querySelector(".launcher") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(root?.querySelector(".option")).not.toBeNull());
      (root?.querySelector(".option") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: "inline/fill",
        entryId: "e1",
        scope: "exact",
      })));
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
  ])("rejects a menu choice covered by auto-pointer outbound %s paint", async (property, value) => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
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
    const actionRect: DOMRect = {
      x: 80,
      y: 120,
      left: 80,
      top: 120,
      right: 260,
      bottom: 180,
      width: 180,
      height: 60,
      toJSON: () => ({}),
    };
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      VISUAL_SURFACE_USER_INTENT,
    );

    try {
      const input = document.querySelector("#username") as HTMLInputElement;
      const host = document.querySelector("palladin-autofill") as HTMLElement;
      const root = host.shadowRoot;
      const launcher = root?.querySelector(".launcher") as HTMLButtonElement;
      const launcherRect = launcherRectFor(input);
      vi.spyOn(launcher, "getBoundingClientRect").mockReturnValue(launcherRect);
      let shadowHit: Element = launcher;
      Object.defineProperty(root, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => shadowHit),
      });
      vi.mocked(document.elementFromPoint).mockReturnValue(host);
      launcher.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        composed: true,
        detail: 1,
        clientX: launcherRect.left + 4,
        clientY: launcherRect.top + 4,
      }));
      await vi.waitFor(() => expect(root?.querySelector(".option")).not.toBeNull());
      const option = root?.querySelector(".option") as HTMLButtonElement;
      vi.spyOn(option, "getBoundingClientRect").mockReturnValue(actionRect);
      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.zIndex = "2147483647";
      overlay.style.pointerEvents = "auto";
      overlay.style.setProperty(property, value);
      document.body.append(overlay);
      vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
        ...actionRect,
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 11,
        bottom: 11,
        width: 1,
        height: 1,
      });
      shadowHit = option;
      option.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        composed: true,
        detail: 1,
        clientX: actionRect.left + 4,
        clientY: actionRect.top + 4,
      }));
      await Promise.resolve();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it("rejects an authentic host moved from form A over form B", async () => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
    document.body.innerHTML = `
      <form id="a"><input id="user-a" autocomplete="username"><input type="password"></form>
      <form id="b"><input id="user-b" autocomplete="username"><input type="password"></form>
    `;
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
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      VISUAL_SURFACE_USER_INTENT,
    );

    try {
      const userB = document.querySelector("#user-b") as HTMLInputElement;
      const hostA = document.querySelectorAll("palladin-autofill")[0] as HTMLElement;
      const rootA = hostA.shadowRoot;
      const launcherA = rootA?.querySelector(".launcher") as HTMLButtonElement;
      const movedRect = launcherRectFor(userB);
      hostA.style.setProperty("left", `${movedRect.left}px`, "important");
      hostA.style.setProperty("top", `${movedRect.top}px`, "important");
      vi.spyOn(hostA, "getBoundingClientRect").mockReturnValue(movedRect);
      vi.spyOn(launcherA, "getBoundingClientRect").mockReturnValue(movedRect);
      Object.defineProperty(rootA, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => launcherA),
      });
      vi.mocked(document.elementFromPoint).mockReturnValue(hostA);
      launcherA.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        composed: true,
        detail: 1,
        clientX: movedRect.left + 4,
        clientY: movedRect.top + 4,
      }));
      await vi.waitFor(() => expect(rootA?.querySelector(".option")).not.toBeNull());
      (rootA?.querySelector(".option") as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "inline/fill" }));
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it("binds the closed-surface choice before a later page window-capture mutation", async () => {
    const nativeAttachShadow = Element.prototype.attachShadow;
    const attachShadow = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      return nativeAttachShadow.call(this, { ...init, mode: "open" });
    });
    document.body.innerHTML = `
      <form id="a"><input id="user-a" autocomplete="username"><input id="pass-a" type="password"></form>
      <form id="b"><input id="user-b" autocomplete="username"><input id="pass-b" type="password"></form>
    `;
    const capabilities = new OneShotInlineFillCapabilities();
    const suggestion = {
      vaultId: "v1",
      entryId: "e1",
      name: "Work",
      username: "ada@example.com",
      vaultName: "Personal",
      urlDomain: "example.com",
      match: "exact" as const,
    };
    const send = vi.fn(async (command: InlineAutofillCommand): Promise<unknown> => {
      if (command.type === "inline/list") {
        return { ok: true, kind: "suggestions", status: "ready", entries: [suggestion] };
      }
      if (command.type !== "inline/fill") return { ok: false, code: "unsupported" };
      const outcome = performBoundFill(document, {
        channel: "palladin.fill/request",
        documentId: command.documentId,
        expectedOrigin: "https://example.com",
        expectedDomain: "example.com",
        capabilityId: command.capabilityId,
        submit: command.submit,
        fields: [
          { kind: "username", value: "must-not-write" },
          { kind: "password", value: "must-not-write" },
        ],
      }, "https://example.com/login", command.documentId, capabilities);
      return {
        ok: true,
        kind: "fill",
        status: outcome.ok ? "filled" : outcome.reason === "no-form" ? "no-form" : "blocked",
      };
    });
    const subject = startInlineAutofill(
      document,
      "a".repeat(32),
      send,
      DIRECT_USER_INTENT,
      capabilities,
    );
    const hosts = document.querySelectorAll("palladin-autofill");
    const hostB = hosts[1] as HTMLElement;
    const rootB = hostB.shadowRoot;
    let hostClicks = 0;
    const pageCaptureAttack = (event: Event): void => {
      if (event.target !== hostB) return;
      hostClicks += 1;
      if (hostClicks === 2) {
        (document.querySelector("#user-b") as HTMLInputElement).setAttribute("form", "a");
        (document.querySelector("#b") as HTMLFormElement).action = "https://evil.test/collect";
      }
    };
    window.addEventListener("click", pageCaptureAttack, true);

    try {
      (rootB?.querySelector(".launcher") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(rootB?.querySelector(".option")).not.toBeNull());
      (rootB?.querySelector(".option") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: "inline/fill",
      })));
      expect((document.querySelector("#user-a") as HTMLInputElement).value).toBe("");
      expect((document.querySelector("#pass-a") as HTMLInputElement).value).toBe("");
      expect((document.querySelector("#pass-b") as HTMLInputElement).value).toBe("");
    } finally {
      window.removeEventListener("click", pageCaptureAttack, true);
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it("does not open the closed surface from a synthetic click", async () => {
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
      status: "ready",
      entries: [],
    }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);

    try {
      const root = document.querySelector("palladin-autofill")?.shadowRoot;
      (root?.querySelector(".launcher") as HTMLButtonElement).click();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
    } finally {
      subject.stop();
      attachShadow.mockRestore();
    }
  });

  it("pins Palladin typography and aligns the launcher to the control height", () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="username" style="padding-right:30px"><input type="password"></form>`;
    const input = document.querySelector("#username") as HTMLInputElement;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(VISIBLE_RECT);
    const subject = startInlineAutofill(document, "a".repeat(32), vi.fn(async () => ({
      ok: true, kind: "suggestions", status: "ready", entries: [],
    })));
    const host = document.querySelector("palladin-autofill") as HTMLElement;
    expect(host.style.getPropertyValue("font-family")).toContain("system-ui");
    expect(host.style.getPropertyPriority("font-family")).toBe("important");
    expect(host.style.left).toBe("383px");
    subject.stop();
  });
});
