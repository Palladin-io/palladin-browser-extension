// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { FillField, FillRequestMessage } from "@shared/messaging";
import { loginTargetFor, performBoundFill, performFill } from "./fill";

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
    loginTargetId: null,
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

  it("fills username and password controls associated from outside their form", () => {
    const doc = mount(`
      <form id="login"></form>
      <input type="email" id="user" form="login" />
      <input type="password" id="pass" form="login" />
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("ada@example.com");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("s3cr3t");
  });

  it("fills an externally associated username that follows its password", () => {
    const doc = mount(`
      <form id="login"></form>
      <input type="password" id="pass" form="login" />
      <input type="email" id="user" form="login" />
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: true });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("ada@example.com");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("s3cr3t");
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

  it("does not fill controls effectively disabled by an ancestor fieldset", () => {
    const doc = mount(`
      <form>
        <fieldset disabled>
          <input type="email" id="user">
          <input type="password" id="pass">
        </fieldset>
      </form>
    `);

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("does not fill controls hidden by page CSS on an ancestor", () => {
    const style = document.createElement("style");
    style.textContent = ".page-hidden { display: none; }";
    document.head.append(style);
    const doc = mount(`
      <section class="page-hidden">
        <form><input type="email" id="user"><input type="password" id="pass"></form>
      </section>
    `);

    try {
      expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
      expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
      expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
    } finally {
      style.remove();
    }
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

  it("does not fill a zero-area password control", () => {
    const doc = mount(`<form><input id="user"><input type="password" id="pass"></form>`);
    const password = doc.getElementById("pass") as HTMLInputElement;
    vi.spyOn(password, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
    vi.spyOn(password, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 20,
      width: 0,
      height: 20,
      toJSON: () => ({}),
    });

    expect(performFill(doc, CREDS)).toEqual({ ok: false, reason: "no-form" });
    expect(password.value).toBe("");
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
  it("refuses an inline target whose username was reassociated before the DOM write", () => {
    const doc = mount(`
      <form id="first"><input id="user"><input id="first-pass" type="password"></form>
      <form id="second"><input id="second-pass" type="password"></form>
    `);
    const username = doc.getElementById("user") as HTMLInputElement;
    const target = loginTargetFor(username);
    if (target === null) throw new Error("expected login target");
    username.setAttribute("form", "second");

    expect(performBoundFill(
      doc,
      bound(CREDS, { expectedDomain: "example.com", loginTargetId: "login-1" }),
      "https://example.com/login",
      "document-1",
      target,
    )).toEqual({ ok: false, reason: "no-form" });
    expect(username.value).toBe("");
    expect((doc.getElementById("first-pass") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("second-pass") as HTMLInputElement).value).toBe("");
  });

  it("does not write the password when the page invalidates the pair after username input", () => {
    const doc = mount(`
      <form><input id="user"><input id="pass" type="password"></form>
    `);
    const username = doc.getElementById("user") as HTMLInputElement;
    const password = doc.getElementById("pass") as HTMLInputElement;
    const target = loginTargetFor(username);
    if (target === null) throw new Error("expected login target");
    username.addEventListener("input", () => {
      password.disabled = true;
    });

    expect(performBoundFill(
      doc,
      bound(CREDS, { expectedDomain: "example.com", loginTargetId: "login-1" }),
      "https://example.com/login",
      "document-1",
      target,
    )).toEqual({ ok: false, reason: "no-form" });
    expect(username.value).toBe("ada@example.com");
    expect(password.value).toBe("");
  });

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
    const loginSubmit = doc.getElementById("login-submit") as HTMLButtonElement;
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
    expect(requestLogin).toHaveBeenCalledWith(loginSubmit);
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
});
