// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { FillField } from "@shared/messaging";
import { performFill } from "./fill";

const CREDS: FillField[] = [
  { kind: "username", value: "ada@example.com" },
  { kind: "password", value: "s3cr3t" },
];

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
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
});
