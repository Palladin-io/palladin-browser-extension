// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://example.com/login" }
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FillField, FillRequestMessage } from "@shared/messaging";
import { OneShotInlineFillCapabilities, performBoundFill, performFill } from "./fill";

const CREDS: FillField[] = [
  { kind: "username", value: "ada@example.com" },
  { kind: "password", value: "s3cr3t" },
];

const CARD: FillField[] = [
  { kind: "cardholder", value: "Ada Lovelace" },
  { kind: "card-number", value: "4111111111111111" },
  { kind: "card-expiry-month", value: "08" },
  { kind: "card-expiry-year", value: "2030" },
  { kind: "card-expiry", value: "08/30" },
  { kind: "billing-address", value: "12 Computing Lane" },
];

const VISIBLE_RECT: DOMRect = {
  x: 40,
  y: 40,
  left: 40,
  top: 40,
  right: 280,
  bottom: 80,
  width: 240,
  height: 40,
  toJSON: () => ({}),
};
let nativeGetComputedStyle: (element: Element) => CSSStyleDeclaration;
let emptyPseudoStyle: CSSStyleDeclaration;

beforeEach(() => {
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
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "elementFromPoint");
});

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function bound(fields: readonly FillField[], over: Partial<FillRequestMessage> = {}): FillRequestMessage {
  return {
    channel: "palladin.fill/request",
    documentId: "document-1",
    expectedOrigin: "https://example.com",
    expectedDomain: null,
    submit: false,
    capabilityId: null,
    fields,
    ...over,
  };
}

describe("performFill", () => {
  it("fills the password and the preceding text field, dispatching input/change", () => {
    const doc = mount(`
      <form>
        <input type="text" id="user" />
        <input type="password" id="pass" />
      </form>
    `);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const events: string[] = [];
    for (const el of [user, pass]) {
      el.addEventListener("input", () => events.push(`${el.id}:input`));
      el.addEventListener("change", () => events.push(`${el.id}:change`));
    }

    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect(user.value).toBe("ada@example.com");
    expect(pass.value).toBe("s3cr3t");
    expect(events).toEqual(["user:input", "user:change", "pass:input", "pass:change"]);
  });

  it("fills a lone password when there is no username field", () => {
    const doc = mount(`<form><input type="password" id="pass" /></form>`);
    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("s3cr3t");
  });

  it("reports no-form when there is no password field", () => {
    const doc = mount(`<form><input type="text" id="user" /></form>`);
    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
  });

  it("inserts a generated value into the focused field", () => {
    const doc = mount(`<form><input type="text" id="focused" /><input type="password" id="pass" /></form>`);
    const focused = doc.getElementById("focused") as HTMLInputElement;
    focused.focus();
    expect(performFill(doc, [{ kind: "generated", value: "fresh-secret" }])).toEqual({ ok: true });
    expect(focused.value).toBe("fresh-secret");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("falls back to a password field when no field is focused", () => {
    const doc = mount(`<form><input type="password" id="pass" /></form>`);
    expect(performFill(doc, [{ kind: "generated", value: "fresh-secret" }])).toEqual({ ok: true });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("fresh-secret");
  });

  it("skips hidden, disabled, and readonly inputs", () => {
    const doc = mount(`
      <form>
        <input type="hidden" id="csrf" />
        <input type="text" id="ghost" style="display:none" />
        <input type="text" id="user" />
        <input type="password" id="pass" />
      </form>
    `);
    performFill(doc, CREDS);
    expect((doc.getElementById("ghost") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("csrf") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("ada@example.com");
  });

  it("does not fill a hidden password field (fails closed to no-form)", () => {
    const doc = mount(`<form><input type="password" id="pass" hidden /></form>`);
    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
  });

  it("does not fill transparent password-manager decoys", () => {
    const doc = mount(`
      <form>
        <input type="password" id="decoy" style="opacity:0;pointer-events:none" />
        <input type="password" id="pass" />
      </form>
    `);
    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect((doc.getElementById("decoy") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("s3cr3t");
  });

  it("does not fill a field hidden by a computed CSS class", () => {
    document.head.innerHTML = `<style>.concealed { display: none; }</style>`;
    const doc = mount(`
      <form>
        <input id="user" />
        <input id="pass" class="concealed" type="password" />
      </form>
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill controls inside a hidden ancestor", () => {
    const doc = mount(`
      <div style="visibility:hidden">
        <form><input id="user" /><input id="pass" type="password" /></form>
      </div>
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill controls disabled by a fieldset", () => {
    const doc = mount(`
      <form><fieldset disabled><input id="user" /><input id="pass" type="password" /></fieldset></form>
    `);
    expect(new OneShotInlineFillCapabilities().issue(
      doc.getElementById("user") as HTMLInputElement,
    )).toBeNull();
    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill controls under an inert ancestor", () => {
    const doc = mount(`
      <form inert><input id="user" /><input id="pass" type="password" /></form>
    `);
    expect(new OneShotInlineFillCapabilities().issue(
      doc.getElementById("user") as HTMLInputElement,
    )).toBeNull();
    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill a zero-size control", () => {
    const doc = mount(`<form><input id="user" /><input id="pass" type="password" /></form>`);
    vi.spyOn(doc.getElementById("pass") as HTMLInputElement, "getBoundingClientRect")
      .mockReturnValue({ ...VISIBLE_RECT, right: 40, bottom: 40, width: 0, height: 0 });

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill an offscreen control", () => {
    const doc = mount(`<form><input id="user" /><input id="pass" type="password" /></form>`);
    vi.spyOn(doc.getElementById("pass") as HTMLInputElement, "getBoundingClientRect")
      .mockReturnValue({
        ...VISIBLE_RECT,
        x: -500,
        left: -500,
        right: -260,
      });

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("never combines username and password controls from different forms", () => {
    const doc = mount(`
      <form id="decoy"><input id="user" /></form>
      <form id="login"><input id="pass" type="password" /></form>
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("s3cr3t");
  });

  it("uses the field just before the password, not one after it", () => {
    const doc = mount(`
      <form>
        <input type="text" id="user" />
        <input type="password" id="pass" />
        <input type="text" id="after" />
      </form>
    `);
    performFill(doc, [{ kind: "username", value: "ada" }, { kind: "password", value: "p" }]);
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("ada");
    expect((doc.getElementById("after") as HTMLInputElement).value).toBe("");
  });

  it("uses a React-style native value setter so controlled inputs update", () => {
    const doc = mount(`<form><input type="password" id="pass" /></form>`);
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const setter = vi.fn(function (this: HTMLInputElement, v: string) {
      Object.defineProperty(this, "value", { value: v, configurable: true, writable: true });
    });
    // Spy on the prototype setter the fill routine reaches for.
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const descriptor: PropertyDescriptor = { configurable: true, set: setter };
    if (original?.get) descriptor.get = original.get;
    Object.defineProperty(HTMLInputElement.prototype, "value", descriptor);
    try {
      performFill(doc, [{ kind: "password", value: "viaSetter" }]);
      expect(setter).toHaveBeenCalledWith("viaSetter");
      expect(pass.value).toBe("viaSetter");
    } finally {
      if (original) Object.defineProperty(HTMLInputElement.prototype, "value", original);
    }
  });

  it("fills only standardized payment and billing autocomplete fields", () => {
    const doc = mount(`
      <form>
        <input id="name" autocomplete="cc-name" />
        <input id="number" autocomplete="cc-number" />
        <input id="month" autocomplete="cc-exp-month" />
        <input id="year" autocomplete="cc-exp-year" />
        <input id="expiry" autocomplete="cc-exp" />
        <textarea id="billing" autocomplete="billing street-address"></textarea>
      </form>
    `);

    expect(performFill(doc, CARD)).toEqual({ ok: true });
    expect((doc.getElementById("name") as HTMLInputElement).value).toBe("Ada Lovelace");
    expect((doc.getElementById("number") as HTMLInputElement).value).toBe("4111111111111111");
    expect((doc.getElementById("month") as HTMLInputElement).value).toBe("08");
    expect((doc.getElementById("year") as HTMLInputElement).value).toBe("2030");
    expect((doc.getElementById("expiry") as HTMLInputElement).value).toBe("08/30");
    expect((doc.getElementById("billing") as HTMLTextAreaElement).value).toBe("12 Computing Lane");
  });

  it("never detects or fills payment authentication fields or label-based lookalikes", () => {
    const doc = mount(`
      <form>
        <input id="standard-code" autocomplete="cc-csc" />
        <input id="named-code" name="securityCode" aria-label="Card security code" />
        <input id="named-pin" name="pin" aria-label="PIN" />
        <input id="custom-code" autocomplete="off" name="customField" aria-label="Verification number" />
      </form>
    `);

    expect(performFill(doc, CARD)).toEqual({ ok: false, reason: "no-form" });
    for (const id of ["standard-code", "named-code", "named-pin", "custom-code"]) {
      expect((doc.getElementById(id) as HTMLInputElement).value).toBe("");
    }
  });

  it("does not put the billing address into shipping or unqualified address fields", () => {
    const doc = mount(`
      <form>
        <input id="shipping" autocomplete="shipping street-address" />
        <input id="ambiguous" autocomplete="street-address" />
      </form>
    `);

    expect(performFill(doc, CARD)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("shipping") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("ambiguous") as HTMLInputElement).value).toBe("");
  });
});

describe("performBoundFill", () => {
  it("submits the exact owning form after an explicitly requested credential fill", () => {
    const doc = mount(`
      <form id="login">
        <input id="user">
        <input id="pass" type="password">
        <button id="login-submit" type="submit">Log in</button>
      </form>
      <form id="other"><button id="other-submit" type="submit">Other</button></form>
    `);
    const login = doc.getElementById("login") as HTMLFormElement;
    const other = doc.getElementById("other") as HTMLFormElement;
    const requestLogin = vi.fn();
    const requestOther = vi.fn();
    login.requestSubmit = requestLogin;
    other.requestSubmit = requestOther;

    expect(performBoundFill(
      doc,
      bound(CREDS, { expectedDomain: "example.com", submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: true });
    expect(requestLogin).toHaveBeenCalledWith();
    expect(requestOther).not.toHaveBeenCalled();
  });

  it("does not submit during an ordinary fill", () => {
    const doc = mount(`<form id="login"><input id="pass" type="password"></form>`);
    const form = doc.getElementById("login") as HTMLFormElement;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    expect(performBoundFill(
      doc,
      bound(CREDS, { expectedDomain: "example.com" }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: true });
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("does not write a credential after the top-frame document changes", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    expect(performBoundFill(
      doc,
      bound(CREDS, { expectedDomain: "example.com" }),
      "https://example.com/login",
      "document-2",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not write card data after the exact origin changes", () => {
    const doc = mount(`<form><input id="number" autocomplete="cc-number"></form>`);
    expect(performBoundFill(
      doc,
      bound(CARD, { expectedOrigin: "https://checkout.example.com" }),
      "https://payments.example.com/next",
      "document-1",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("number") as HTMLInputElement).value).toBe("");
  });

  it("does not write a generated value after the prepared domain changes", () => {
    const doc = mount(`<form><input id="pass" type="password"></form>`);
    expect(performBoundFill(
      doc,
      bound([{ kind: "generated", value: "fresh-secret" }], {
        expectedDomain: "example.com",
      }),
      "https://evil.test/login",
      "document-1",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("consumes an exact inline capability once and rejects replay", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(doc.getElementById("user") as HTMLInputElement);
    if (capabilityId === null) throw new Error("capability was not issued");
    const message = bound(CREDS, { capabilityId });

    expect(performBoundFill(
      doc,
      message,
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: true });
    expect(performBoundFill(
      doc,
      message,
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
  });

  it("submits only the exact form captured by an inline capability", () => {
    const doc = mount(`
      <form id="a"><input id="user-a"><input id="pass-a" type="password"><button type="submit">A</button></form>
      <form id="b"><input id="user-b"><input id="pass-b" type="password"><button id="submit-b" type="submit">B</button></form>
    `);
    const formA = doc.getElementById("a") as HTMLFormElement;
    const formB = doc.getElementById("b") as HTMLFormElement;
    const submitA = vi.fn();
    const submitExactB = vi.fn();
    formA.requestSubmit = submitA;
    formB.requestSubmit = submitExactB;
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(doc.getElementById("user-b") as HTMLInputElement);
    if (capabilityId === null) throw new Error("capability was not issued");

    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId, submit: true }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: true });
    expect(submitExactB).toHaveBeenCalledWith();
    expect(submitA).not.toHaveBeenCalled();
    expect((doc.getElementById("pass-a") as HTMLInputElement).value).toBe("");
  });

  it("does not activate an unbound hidden submitter with attacker overrides", () => {
    const doc = mount(`
      <form id="login">
        <input id="user"><input id="pass" type="password">
        <button hidden type="submit" formaction="https://evil.test/collect"
          formmethod="post" formenctype="text/plain" formtarget="_blank">Hidden</button>
        <button type="submit">Visible</button>
      </form>
    `);
    const form = doc.getElementById("login") as HTMLFormElement;
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    expect(performBoundFill(
      doc,
      bound(CREDS, { submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: true });
    expect(requestSubmit).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledWith();
  });

  it("rejects an HTTP form action before a requested credential write", () => {
    const doc = mount(`
      <form action="http://example.com/collect"><input id="user"><input id="pass" type="password"></form>
    `);
    const requestSubmit = vi.fn();
    (doc.querySelector("form") as HTMLFormElement).requestSubmit = requestSubmit;

    expect(performBoundFill(
      doc,
      bound(CREDS, { submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP base URL", "http://evil.test/"],
    ["a cross-origin HTTPS base URL", "https://evil.test/"],
  ])("uses the browser-effective action and rejects %s", (_label, baseHref) => {
    document.head.innerHTML = `<base href="${baseHref}">`;
    const doc = mount(`
      <form action="collect"><input id="user"><input id="pass" type="password"></form>
    `);
    const requestSubmit = vi.fn();
    (doc.querySelector("form") as HTMLFormElement).requestSubmit = requestSubmit;

    expect(performBoundFill(
      doc,
      bound(CREDS, { submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("rejects an explicit cross-origin HTTPS form action", () => {
    const doc = mount(`
      <form action="https://evil.test/collect"><input id="user"><input id="pass" type="password"></form>
    `);

    expect(performBoundFill(
      doc,
      bound(CREDS, { submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: false, reason: "target-changed" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("rejects a capability after DOM generation or initial field state changes", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const capabilities = new OneShotInlineFillCapabilities();

    const staleGeneration = capabilities.issue(user);
    if (staleGeneration === null) throw new Error("capability was not issued");
    capabilities.noteDomMutation();
    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId: staleGeneration }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(pass.value).toBe("");

    const changedState = capabilities.issue(user);
    if (changedState === null) throw new Error("capability was not issued");
    user.value = "page-mutated";
    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId: changedState }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(pass.value).toBe("");
  });

  it("treats mutations under a page-created extension-tag impostor as page mutations", () => {
    const doc = mount(`
      <palladin-autofill id="impostor"></palladin-autofill>
      <form><input id="user"><input id="pass" type="password"></form>
    `);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const impostor = doc.getElementById("impostor") as HTMLElement;
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(user);
    if (capabilityId === null) throw new Error("capability was not issued");

    impostor.append(doc.createElement("span"));

    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(pass.value).toBe("");
  });

  it("does not issue a capability for a transparent or occluded target", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const capabilities = new OneShotInlineFillCapabilities();

    user.style.opacity = "0";
    expect(capabilities.issue(user)).toBeNull();
    user.style.opacity = "1";
    const overlay = doc.createElement("div");
    doc.body.append(overlay);
    vi.mocked(doc.elementFromPoint).mockReturnValue(overlay);
    expect(capabilities.issue(user)).toBeNull();
  });

  it.each([
    ["filter", "opacity(0)"],
    ["clip-path", "circle(0 at 0 0)"],
    ["mask-image", "linear-gradient(transparent, transparent)"],
  ])("does not issue a capability when computed %s makes paint unverifiable", (property, value) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    user.style.setProperty(property, value);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("does not issue a capability for a paintless transparent control box", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    user.style.backgroundColor = "transparent";
    user.style.border = "0";
    user.style.color = "transparent";
    user.style.appearance = "none";

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
    ["text-shadow", "0 0 1000px rgb(20, 30, 40)"],
    ["filter", "drop-shadow(0 0 1000px rgb(20, 30, 40))"],
  ])("rejects outbound %s paint on the exact clicked control", (property, value) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    user.focus();
    user.style.setProperty(property, value);
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("allows only a bounded native focus outline on the active exact control", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    user.focus();
    user.style.outline = "5px auto -webkit-focus-ring-color";

    expect(new OneShotInlineFillCapabilities().issue(user)).not.toBeNull();

    user.style.outline = "1000px auto -webkit-focus-ring-color";
    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();

    user.style.outline = "5px auto -webkit-focus-ring-color";
    user.style.outlineOffset = "1000px";
    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("rejects a painted pointer-events:none overlay omitted by elementFromPoint", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "none";
    overlay.style.backgroundColor = "rgb(20, 30, 40)";
    doc.body.append(overlay);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(VISIBLE_RECT);
    // Chrome hit testing intentionally skips pointer-transparent paint and
    // therefore reports the input even though the overlay is visible.
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
    ["text-shadow", "0 0 1000px rgb(20, 30, 40)"],
    ["filter", "drop-shadow(0 0 1000px rgb(20, 30, 40))"],
  ])("rejects pointer-transparent outbound %s paint beyond a non-overlapping rect", (property, value) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const overlay = doc.createElement("div");
    overlay.textContent = "paint";
    overlay.style.pointerEvents = "none";
    overlay.style.backgroundColor = "rgb(20, 30, 40)";
    overlay.style.setProperty(property, value);
    doc.body.append(overlay);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      ...VISIBLE_RECT,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    // Mirrors Chrome: outlines/shadows do not enlarge the hit-test box.
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
  ])("rejects auto-pointer outbound %s paint outside its hit-test box", (property, value) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "auto";
    overlay.style.setProperty(property, value);
    doc.body.append(overlay);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      ...VISIBLE_RECT,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    // Chromium does not add outline/shadow overflow to the hit-test box even
    // when the element itself accepts pointer events.
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("does not trust a page-created element that imitates the extension host tag", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const impostor = doc.createElement("palladin-autofill");
    impostor.style.pointerEvents = "none";
    impostor.style.backgroundColor = "rgb(20, 30, 40)";
    doc.body.append(impostor);
    vi.spyOn(impostor, "getBoundingClientRect").mockReturnValue(VISIBLE_RECT);
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each(["::before", "::after"] as const)(
    "rejects an opaque full-page body%s overlay omitted by elementFromPoint",
    (pseudo) => {
      const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
      const user = doc.getElementById("user") as HTMLInputElement;
      const pseudoStyle = doc.createElement("span").style;
      pseudoStyle.content = '""';
      pseudoStyle.display = "block";
      pseudoStyle.position = "fixed";
      pseudoStyle.pointerEvents = "none";
      pseudoStyle.inset = "0";
      pseudoStyle.backgroundColor = "rgb(0, 0, 0)";
      pseudoStyle.opacity = "1";
      pseudoStyle.visibility = "visible";
      vi.mocked(window.getComputedStyle).mockImplementation((element, pseudoElement) => {
        if (element === doc.body && pseudoElement === pseudo) return pseudoStyle;
        return pseudoElement === undefined || pseudoElement === null || pseudoElement === ""
          ? nativeGetComputedStyle(element)
          : emptyPseudoStyle;
      });
      // Mirrors Chrome: pointer-transparent pseudo paint is not the hit target.
      vi.mocked(doc.elementFromPoint).mockReturnValue(user);

      expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
    },
  );

  it.each([
    ['url("data:image/png;base64,AA==")', "image"],
    ["counter(item)", "counter"],
  ])("rejects generated %s content on the exact target despite transparent text color", (content) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pseudoStyle = doc.createElement("span").style;
    pseudoStyle.content = content;
    pseudoStyle.display = "block";
    pseudoStyle.position = "absolute";
    pseudoStyle.pointerEvents = "none";
    pseudoStyle.color = "transparent";
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === user && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("rejects a painted pointer-transparent overlay inside an open shadow tree", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const host = doc.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "none";
    overlay.style.backgroundColor = "rgb(20, 30, 40)";
    shadow.append(overlay);
    doc.body.append(host);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(VISIBLE_RECT);
    // Mirrors Chrome: pointer-transparent shadow paint is omitted from the
    // ordinary hit target even though it covers the field.
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("rejects outbound outline paint from a non-overlapping open shadow descendant", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const host = doc.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "none";
    overlay.style.outline = "1000px solid rgb(20, 30, 40)";
    shadow.append(overlay);
    doc.body.append(host);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      ...VISIBLE_RECT,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
  ])("rejects auto-pointer outbound %s paint in an open shadow tree", (property, value) => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const host = doc.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "auto";
    overlay.style.setProperty(property, value);
    shadow.append(overlay);
    doc.body.append(host);
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      ...VISIBLE_RECT,
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 11,
      bottom: 11,
      width: 1,
      height: 1,
    });
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("rejects outbound pseudo outline paint beyond its origin rectangle", () => {
    const doc = mount(`
      <div id="origin"></div>
      <form><input id="user"><input id="pass" type="password"></form>
    `);
    const user = doc.getElementById("user") as HTMLInputElement;
    const origin = doc.getElementById("origin") as HTMLElement;
    const pseudoStyle = doc.createElement("span").style;
    pseudoStyle.content = '""';
    pseudoStyle.display = "block";
    pseudoStyle.position = "static";
    pseudoStyle.pointerEvents = "none";
    pseudoStyle.outline = "1000px solid rgb(20, 30, 40)";
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === origin && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it.each([
    ["outline", "1000px solid rgb(20, 30, 40)"],
    ["box-shadow", "0 0 0 1000px rgb(20, 30, 40)"],
  ])("rejects auto-pointer outbound pseudo %s paint", (property, value) => {
    const doc = mount(`
      <div id="origin"></div>
      <form><input id="user"><input id="pass" type="password"></form>
    `);
    const user = doc.getElementById("user") as HTMLInputElement;
    const origin = doc.getElementById("origin") as HTMLElement;
    const pseudoStyle = doc.createElement("span").style;
    pseudoStyle.content = '""';
    pseudoStyle.display = "block";
    pseudoStyle.position = "static";
    pseudoStyle.pointerEvents = "auto";
    pseudoStyle.setProperty(property, value);
    pseudoStyle.opacity = "1";
    pseudoStyle.visibility = "visible";
    vi.mocked(window.getComputedStyle).mockImplementation((element, pseudo) => {
      if (element === origin && pseudo === "::before") return pseudoStyle;
      return pseudo === undefined || pseudo === null || pseudo === ""
        ? nativeGetComputedStyle(element)
        : emptyPseudoStyle;
    });
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("rejects an overlapping host when a closed page shadow tree cannot be inspected", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const host = doc.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    const overlay = doc.createElement("div");
    overlay.style.pointerEvents = "none";
    overlay.style.backgroundColor = "rgb(20, 30, 40)";
    shadow.append(overlay);
    doc.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(VISIBLE_RECT);
    vi.mocked(doc.elementFromPoint).mockReturnValue(user);

    expect(new OneShotInlineFillCapabilities().issue(user)).toBeNull();
  });

  it("repeats hit-testing after username handlers and stops before the password write", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const overlay = doc.createElement("div");
    doc.body.append(overlay);
    let passwordOccluded = false;
    vi.mocked(doc.elementFromPoint).mockImplementation((x, y) => {
      const passwordRect = pass.getBoundingClientRect();
      if (passwordOccluded
        && x >= passwordRect.left && x <= passwordRect.right
        && y >= passwordRect.top && y <= passwordRect.bottom) return overlay;
      return [...doc.querySelectorAll<HTMLElement>("input, textarea")].find((element) => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) ?? null;
    });
    user.addEventListener("input", () => { passwordOccluded = true; });
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(user);
    if (capabilityId === null) throw new Error("capability was not issued");

    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(user.value).toBe("ada@example.com");
    expect(pass.value).toBe("");
  });

  it("rechecks DOM generation synchronously after username page handlers", () => {
    const doc = mount(`<form><input id="user"><input id="pass" type="password"></form>`);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    user.addEventListener("change", () => doc.body.append(doc.createElement("aside")));
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(user);
    if (capabilityId === null) throw new Error("capability was not issued");

    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(user.value).toBe("ada@example.com");
    expect(pass.value).toBe("");
  });

  it("never reselects or submits a replacement form created by page handlers", () => {
    const doc = mount(`
      <form id="login">
        <input id="user"><input id="pass" type="password"><button type="submit">Log in</button>
      </form>
    `);
    const user = doc.getElementById("user") as HTMLInputElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const original = doc.getElementById("login") as HTMLFormElement;
    const originalSubmit = vi.fn();
    original.requestSubmit = originalSubmit;
    const replacementSubmit = vi.fn();
    pass.addEventListener("input", () => {
      const replacement = doc.createElement("form");
      replacement.id = "replacement";
      replacement.innerHTML = `<input id="new-user"><input id="new-pass" type="password">`;
      replacement.requestSubmit = replacementSubmit;
      original.replaceWith(replacement);
    });
    const capabilities = new OneShotInlineFillCapabilities();
    const capabilityId = capabilities.issue(user);
    if (capabilityId === null) throw new Error("capability was not issued");

    expect(performBoundFill(
      doc,
      bound(CREDS, { capabilityId, submit: true }),
      "https://example.com/login",
      "document-1",
      capabilities,
    )).toEqual({ ok: false, reason: "target-changed" });
    expect(originalSubmit).not.toHaveBeenCalled();
    expect(replacementSubmit).not.toHaveBeenCalled();
    expect((doc.getElementById("new-pass") as HTMLInputElement).value).toBe("");
  });

  it("never adopts a different form when handlers move the exact password before submit", () => {
    const doc = mount(`
      <form id="login"><input id="user"><input id="pass" type="password"></form>
      <form id="other"></form>
    `);
    const login = doc.getElementById("login") as HTMLFormElement;
    const other = doc.getElementById("other") as HTMLFormElement;
    const pass = doc.getElementById("pass") as HTMLInputElement;
    const loginSubmit = vi.fn();
    const otherSubmit = vi.fn();
    login.requestSubmit = loginSubmit;
    other.requestSubmit = otherSubmit;
    pass.addEventListener("change", () => other.append(pass));

    expect(performBoundFill(
      doc,
      bound(CREDS, { submit: true }),
      "https://example.com/login",
      "document-1",
    )).toEqual({ ok: false, reason: "no-form" });
    expect(loginSubmit).not.toHaveBeenCalled();
    expect(otherSubmit).not.toHaveBeenCalled();
  });
});
