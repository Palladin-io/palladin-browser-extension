// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { AgentInjectStepMessage } from "@shared/messaging";

import {
  createAgentInjectDomAccess,
  inspectAgentInjectTransition,
  performAgentInjectStep,
  type AgentInjectDomAccess,
} from "./agent-inject";

const visible: AgentInjectDomAccess = {
  isVisible: (element) => !element.hidden && !element.classList.contains("hidden"),
};
const DOCUMENT_ID = "d".repeat(32);

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function combined(overrides: Partial<AgentInjectStepMessage> = {}): AgentInjectStepMessage {
  return {
    channel: "palladin.agent-inject/step",
    expectedDomain: "login.example.com",
    documentId: DOCUMENT_ID,
    step: {
      fields: [
        { entryFieldId: "credential.username", selector: "#user", control: "username" },
        { entryFieldId: "credential.password", selector: "#pass", control: "password" },
      ],
      submit: { action: "click", selector: "#submit" },
    },
    values: [
      { entryFieldId: "credential.username", value: "fixture-user" },
      { entryFieldId: "credential.password", value: "fixture-password" },
    ],
    ...overrides,
  };
}

describe("declarative Agent Inject step", () => {
  it("ignores only the registered Palladin overlay during visibility checks", () => {
    const doc = mount('<input id="user" type="text" />');
    const input = doc.getElementById("user") as HTMLInputElement;
    const ownedOverlay = doc.createElement("palladin-autofill");
    const foreignOverlay = doc.createElement("div");
    doc.body.append(ownedOverlay, foreignOverlay);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      bottom: 30,
      height: 20,
      left: 10,
      right: 110,
      top: 10,
      width: 100,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    });
    Object.defineProperties(doc.documentElement, {
      clientHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 1200 },
    });
    Object.defineProperty(doc, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [ownedOverlay, input]),
    });
    Object.defineProperty(doc, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => ownedOverlay),
    });

    expect(createAgentInjectDomAccess(doc, (element) => element === ownedOverlay)
      .isVisible(input)).toBe(true);

    Object.defineProperty(doc, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [ownedOverlay, foreignOverlay, input]),
    });
    expect(createAgentInjectDomAccess(doc, (element) => element === ownedOverlay)
      .isVisible(input)).toBe(false);
  });

  it("fills and submits only the exact declared controls", () => {
    const doc = mount(`
      <input id="decoy" type="password" />
      <form>
        <input id="user" type="email" />
        <input id="pass" type="password" />
        <button id="submit" type="button">Sign in</button>
      </form>
    `);
    const click = vi.fn();
    doc.getElementById("submit")?.addEventListener("click", click);

    expect(performAgentInjectStep(
      doc,
      combined(),
      DOCUMENT_ID,
      () => "https://login.example.com/start",
      visible,
    )).toEqual({ ok: true });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("fixture-user");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("fixture-password");
    expect((doc.getElementById("decoy") as HTMLInputElement).value).toBe("");
    expect(click).toHaveBeenCalledOnce();
  });

  it("rejects a replaced document before the first DOM write", () => {
    const doc = mount(`
      <input id="user" type="email" />
      <input id="pass" type="password" />
      <button id="submit" type="button"></button>
    `);
    const click = vi.fn();
    doc.getElementById("submit")?.addEventListener("click", click);

    expect(performAgentInjectStep(
      doc,
      combined(),
      "e".repeat(32),
      () => "https://login.example.com/start",
      visible,
    )).toEqual({ ok: false, outcome: "stale-form-map" });
    expect((doc.getElementById("user") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
    expect(click).not.toHaveBeenCalled();
  });

  it("supports arbitrary approved text and OTP fields", () => {
    const doc = mount(`
      <form>
        <textarea id="note"></textarea>
        <input id="otp" type="number" />
        <button id="submit" type="button">Continue</button>
      </form>
    `);
    const message: AgentInjectStepMessage = {
      channel: "palladin.agent-inject/step",
      expectedDomain: "example.com",
      documentId: DOCUMENT_ID,
      step: {
        fields: [
          { entryFieldId: "custom:note", selector: "#note", control: "text" },
          { entryFieldId: "credential.totp", selector: "#otp", control: "otp" },
        ],
        submit: { action: "click", selector: "#submit" },
      },
      values: [
        { entryFieldId: "custom:note", value: "public fixture note" },
        { entryFieldId: "credential.totp", value: "123456" },
      ],
    };
    expect(performAgentInjectStep(
      doc,
      message,
      DOCUMENT_ID,
      () => "https://login.example.com",
      visible,
    )).toEqual({ ok: true });
    expect((doc.getElementById("note") as HTMLTextAreaElement).value).toBe("public fixture note");
    expect((doc.getElementById("otp") as HTMLInputElement).value).toBe("123456");
  });

  it("fails closed for ambiguous, hidden, or semantically incompatible fields", () => {
    const ambiguous = mount(`
      <input class="pass" type="password" />
      <input class="pass" type="password" />
      <button id="submit"></button>
    `);
    expect(performAgentInjectStep(ambiguous, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: ".pass", control: "password" }],
        submit: { action: "click", selector: "#submit" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => "https://login.example.com", visible)).toEqual({
      ok: false,
      outcome: "ambiguous-form",
    });

    const incompatible = mount(`
      <input id="pass" type="text" />
      <button id="submit"></button>
    `);
    expect(performAgentInjectStep(incompatible, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
        submit: { action: "click", selector: "#submit" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => "https://login.example.com", visible)).toEqual({
      ok: false,
      outcome: "ambiguous-form",
    });
  });

  it("returns the bounded missing-password and missing-submit outcomes", () => {
    const noPassword = mount(`<button id="submit"></button>`);
    expect(performAgentInjectStep(noPassword, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
        submit: { action: "click", selector: "#submit" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => "https://login.example.com", visible)).toEqual({
      ok: false,
      outcome: "no-password-field",
    });

    const noSubmit = mount(`<input id="pass" type="password" />`);
    expect(performAgentInjectStep(noSubmit, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
        submit: { action: "click", selector: "#missing" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => "https://login.example.com", visible)).toEqual({
      ok: false,
      outcome: "no-submit-control",
    });
    expect((noSubmit.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("re-checks origin around every write and clears a written secret on a race", () => {
    const doc = mount(`
      <input id="pass" type="password" />
      <button id="submit" type="button"></button>
    `);
    let url = "https://login.example.com/start";
    doc.getElementById("pass")?.addEventListener("input", () => {
      url = "https://evil.example.com/phish";
    });
    expect(performAgentInjectStep(doc, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
        submit: { action: "click", selector: "#submit" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => url, visible)).toEqual({ ok: false, outcome: "origin-mismatch" });
    expect((doc.getElementById("pass") as HTMLInputElement).value).toBe("");
  });

  it("implements press-enter on the declared field without selecting another control", () => {
    const doc = mount(`
      <form id="login">
        <input id="pass" type="password" />
      </form>
    `);
    const submit = vi.fn((event: Event) => event.preventDefault());
    doc.getElementById("login")?.addEventListener("submit", submit);
    expect(performAgentInjectStep(doc, combined({
      step: {
        fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
        submit: { action: "press-enter", selector: "#pass" },
      },
      values: [{ entryFieldId: "credential.password", value: "fixture-password" }],
    }), DOCUMENT_ID, () => "https://login.example.com", visible)).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("Agent Inject transition probe", () => {
  it("distinguishes ready, missing, ambiguous, and changed-origin states", () => {
    const doc = mount(`<input class="next" /><div id="status"></div>`);
    expect(inspectAgentInjectTransition(
      doc, ".next", "example.com", () => "https://login.example.com", visible,
    )).toEqual({ status: "ready" });
    expect(inspectAgentInjectTransition(
      doc, ".missing", "example.com", () => "https://login.example.com", visible,
    )).toEqual({ status: "missing" });
    doc.body.insertAdjacentHTML("beforeend", `<input class="next" />`);
    expect(inspectAgentInjectTransition(
      doc, ".next", "example.com", () => "https://login.example.com", visible,
    )).toEqual({ status: "ambiguous" });
    expect(inspectAgentInjectTransition(
      doc, "#status", "login.example.com", () => "https://evil.example.com", visible,
    )).toEqual({ status: "origin-mismatch" });
    expect(inspectAgentInjectTransition(
      doc, "#status", "example.com", () => "http://example.com", visible,
    )).toEqual({ status: "insecure-origin" });
  });
});
