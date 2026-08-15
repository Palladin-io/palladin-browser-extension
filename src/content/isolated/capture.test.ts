// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { CAPTURE_FILL_CHANNEL } from "@shared/messaging/capture";

import { PasswordCaptureController } from "./capture";

const URL = "https://accounts.example.com/register";
const CANDIDATE_ID = "candidate_0123456789abcdef";
const DOCUMENT_ID = "document_0123456789abcdef";

function controller(): PasswordCaptureController {
  return new PasswordCaptureController(document, () => URL, DOCUMENT_ID, () => CANDIDATE_ID);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("PasswordCaptureController", () => {
  it("detects an explicit registration form without reading or sending values", () => {
    document.body.innerHTML = `
      <form><input type="password" autocomplete="new-password" value="page-secret"></form>
    `;

    const messages = controller().scan();

    expect(messages).toEqual([{
      channel: "palladin.capture/detected",
      documentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      kind: "registration",
    }]);
    expect(JSON.stringify(messages)).not.toContain("page-secret");
  });

  it("detects password change and fills only new + confirmation fields", () => {
    document.body.innerHTML = `
      <form>
        <input id="current" type="password" autocomplete="current-password" value="old-secret">
        <input id="next" type="password" autocomplete="new-password">
        <input id="confirm" type="password" autocomplete="new-password">
      </form>
    `;
    const capture = controller();
    expect(capture.scan()[0]?.kind).toBe("password-change");

    const outcome = capture.fill({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-strong-password",
    });

    expect(outcome).toEqual({ ok: true });
    expect(document.querySelector<HTMLInputElement>("#current")?.value).toBe("old-secret");
    expect(document.querySelector<HTMLInputElement>("#next")?.value).toBe("generated-strong-password");
    expect(document.querySelector<HTMLInputElement>("#confirm")?.value).toBe("generated-strong-password");
  });

  it("ignores login and ambiguous password forms", () => {
    document.body.innerHTML = `
      <form id="login"><input type="password" autocomplete="current-password"></form>
      <form id="ambiguous">
        <input type="password" autocomplete="new-password">
        <input type="password">
      </form>
    `;
    expect(controller().scan()).toEqual([]);
  });

  it("ignores hidden, disabled, and insecure candidates", () => {
    document.body.innerHTML = `
      <form><input type="password" autocomplete="new-password" hidden></form>
    `;
    expect(controller().scan()).toEqual([]);

    const insecure = new PasswordCaptureController(
      document,
      () => "http://accounts.example.com/register",
      DOCUMENT_ID,
      () => CANDIDATE_ID,
    );
    expect(insecure.scan()).toEqual([]);
  });

  it("keeps a stable id and announces a live candidate only once", () => {
    document.body.innerHTML = `
      <form><input type="password" autocomplete="section-signup new-password"></form>
    `;
    const capture = controller();
    expect(capture.scan()).toHaveLength(1);
    expect(capture.scan()).toEqual([]);
  });

  it("fails closed when navigation or DOM shape changes before fill", () => {
    let url = URL;
    document.body.innerHTML = `
      <form><input id="next" type="password" autocomplete="new-password"></form>
    `;
    const capture = new PasswordCaptureController(document, () => url, DOCUMENT_ID, () => CANDIDATE_ID);
    capture.scan();
    url = "https://evil.example.net/register";
    expect(capture.fill({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-strong-password",
    })).toEqual({ ok: false, reason: "origin-changed" });

    url = URL;
    document.querySelector("form")?.append(document.createElement("input"));
    const unknown = document.querySelector("form input:last-child") as HTMLInputElement;
    unknown.type = "password";
    expect(capture.fill({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-strong-password",
    })).toEqual({ ok: false, reason: "stale-candidate" });
  });

  it("fails closed when the worker targets a different page-load document", () => {
    document.body.innerHTML = `
      <form><input id="next" type="password" autocomplete="new-password"></form>
    `;
    const capture = controller();
    capture.scan();

    expect(capture.fill({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: "document_ffffffffffffffff",
      candidateId: CANDIDATE_ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-strong-password",
    })).toEqual({ ok: false, reason: "stale-candidate" });
    expect(document.querySelector<HTMLInputElement>("#next")?.value).toBe("");
  });
});
