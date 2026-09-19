// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_FORM_INSPECT_CHANNEL, type AgentFormSnapshot } from "@shared/messaging/agent-form";
import { AgentFormRegistry } from "./agent-form";

const documentId = "d".repeat(32);
const targetUrl = "https://accounts.example.com/register";
const message = { channel: AGENT_FORM_INSPECT_CHANNEL, documentId, targetUrl };
const dom = { isVisible: (element: HTMLElement) => !element.hidden && !element.classList.contains("covered") };

function registry(options: { url?: () => string; top?: () => boolean; now?: () => number } = {}) {
  return new AgentFormRegistry(document, documentId, options.url ?? (() => targetUrl),
    options.top ?? (() => true), dom, options.now);
}

function snapshot(forms: AgentFormRegistry): AgentFormSnapshot {
  const result = forms.inspect(message);
  expect(result.outcome).toBe("ready");
  if (result.outcome !== "ready") throw new Error("Expected form snapshot");
  return result.snapshot;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("value-free live form registry", () => {
  it('does not advertise a verification code as username when page autocomplete conflicts with its exact OTP label', () => {
    document.body.innerHTML = '<input autocomplete="username" placeholder="请输入验证码"><input autocomplete="username" placeholder="Username">';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['one-time-code', 'username']);
    forms.clear();
  });
  it('recognizes the full Slovak login/email label without matching explanatory copy or conflicting identity', () => {
    document.body.innerHTML = '<input placeholder="Prihlasovacie meno alebo e-mailová adresa"><input placeholder="Hľadať prihlasovacie meno alebo e-mailová adresa"><input name="email" placeholder="Prihlasovacie meno alebo e-mailová adresa">';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['username', null, null]);
    forms.clear();
  });
  it('recognizes exact observed Chinese account, phone and verification placeholders without reading values', () => {
    document.body.innerHTML = '<input placeholder="请输入账号"><input placeholder="请输入手机号"><input placeholder="请输入验证码"><input placeholder="搜索账号"><input placeholder="请输入账号或其他内容"><input name="email" placeholder="请输入账号">';
    for (const input of document.querySelectorAll('input')) Object.defineProperty(input, 'value', { get() { throw new Error('No value reads'); } });
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['username', 'tel', 'one-time-code', null, null, null]);
    forms.clear();
  });
  it('recognizes the exact Polish email-address label without borrowing longer search copy', () => {
    document.body.innerHTML = '<label>Adres email<input name="account"></label><label>Wyszukaj adres email<input></label>';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['email', null]);
    forms.clear();
  });
  it('recognizes trailing label punctuation without accepting a longer unrelated label', () => {
    document.body.innerHTML = '<label>Login lub e-mail:<input></label><label>Powtórz hasło: *<input type="password"></label><label>Wyszukaj login lub e-mail:<input></label>';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['username', 'confirm-password', null]);
    forms.clear();
  });
  it('refines generic name metadata with a specific given/family name hint while rejecting conflicts', () => {
    document.body.innerHTML = '<input name="name" placeholder="Imię"><input name="name" placeholder="Nazwisko"><input name="firstName" aria-label="Last name"><input name="name" placeholder="First name" aria-label="Last name">';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual(['given-name', 'family-name', null, null]);
    forms.clear();
  });
  it("recognizes semantics and constraints without reading any values or changing the page", () => {
    document.body.innerHTML = `<form>
      <input autocomplete="username" required>
      <input type="password" autocomplete="new-password" minlength="16" maxlength="64" pattern="[A-Z]+">
      <label>Powtórz hasło<input type="password"></label>
      <input autocomplete="one-time-code"><button>Register</button>
    </form>`;
    const submit = vi.fn();
    document.querySelector("form")!.addEventListener("submit", submit);
    for (const input of document.querySelectorAll("input")) {
      Object.defineProperty(input, "value", { get: () => { throw new Error("Value read forbidden"); } });
    }
    const before = document.body.innerHTML;
    const forms = registry();
    const result = snapshot(forms);
    expect(result.controls.map(({ purpose }) => purpose)).toEqual([
      "username", "new-password", "confirm-password", "one-time-code", null,
    ]);
    expect(result.controls[1]).toMatchObject({ minLength: 16, maxLength: 64, hasPattern: true });
    expect(JSON.stringify(result)).not.toMatch(/Powtórz|Register|\[A-Z\]|"value"|pattern"/);
    expect(document.body.innerHTML).toBe(before);
    expect(submit).not.toHaveBeenCalled();
    forms.clear();
  });

  it("does not guess generic password fields or contradictory labels", () => {
    document.body.innerHTML = `<input type="password" name="password">
      <input type="password" name="confirm" aria-label="New password">
      <input type="text" autocomplete="new-password">
      <input type="password" autocomplete="new-password current-password">`;
    const forms = registry();
    expect(snapshot(forms).controls.every(({ purpose }) => purpose === null)).toBe(true);
    forms.clear();
  });

  it("does not treat identity substrings in unrelated signup fields as purposes", () => {
    document.body.innerHTML = '<input name="signupUsernameSearch"><input name="registrationEmailFilter"><input name="signupUsername" aria-label="Email">';
    const forms = registry();
    expect(snapshot(forms).controls.map(control => control.purpose)).toEqual([null, null, null]);
    forms.clear();
  });

  it("covers standard input, textarea, select, radio, checkbox and nested open Shadow DOM", () => {
    document.body.innerHTML = `<textarea></textarea><select><option>A</option><option>B</option></select>
      <input type="radio"><input type="checkbox"><input type="number"><div id="host"></div>`;
    const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<label>Adres e-mail<input type="text"></label><div id="nested"></div>';
    const nested = shadow.getElementById("nested")!.attachShadow({ mode: "open" });
    nested.innerHTML = '<input type="password" autocomplete="new-password">';
    const forms = registry();
    const result = snapshot(forms);
    expect(result.controls.map(({ kind }) => kind)).toEqual(["textarea", "select", "radio", "checkbox", "number", "text", "password"]);
    expect(result.controls[1]?.optionCount).toBe(2);
    expect(result.controls[5]?.purpose).toBe("email");
    expect(forms.resolve(result.snapshotId, result.controls[6]!.ref)).toBe(nested.querySelector("input"));
    forms.clear();
  });

  it("excludes hidden, covered, readonly, inert and disabled controls including disabled fieldsets", () => {
    document.body.innerHTML = `<input type="hidden"><input hidden><input class="covered"><input readonly>
      <div inert><input></div><fieldset disabled><input></fieldset><input disabled>
      <div aria-hidden="true"><input></div><input autocomplete="email">`;
    const forms = registry();
    expect(snapshot(forms).controls).toHaveLength(1);
    forms.clear();
  });

  it("invalidates a snapshot synchronously when a node is replaced with the same id", () => {
    document.body.innerHTML = '<input id="password" type="password" autocomplete="new-password">';
    const forms = registry();
    const first = snapshot(forms);
    const original = document.getElementById("password")!;
    original.replaceWith(original.cloneNode());
    expect(forms.resolve(first.snapshotId, first.controls[0]!.ref)).toBeNull();
    const second = snapshot(forms);
    expect(second.controls[0]?.ref).not.toBe(first.controls[0]?.ref);
    expect(forms.resolve(second.snapshotId, first.controls[0]!.ref)).toBeNull();
    forms.clear();
  });

  it("invalidates after delayed fields or changes in an open shadow root", () => {
    document.body.innerHTML = '<div id="host"></div>';
    const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input type="email">';
    const forms = registry();
    const first = snapshot(forms);
    shadow.append(document.createElement("input"));
    expect(forms.resolve(first.snapshotId, first.controls[0]!.ref)).toBeNull();
    expect(snapshot(forms).controls).toHaveLength(2);
    forms.clear();
  });

  it("rejects old references after SPA navigation, time expiry and explicit clearing", () => {
    document.body.innerHTML = '<input type="email">';
    let url = targetUrl;
    let now = 0;
    const forms = registry({ url: () => url, now: () => now });
    const first = snapshot(forms);
    url = `${targetUrl}?step=2`;
    expect(forms.resolve(first.snapshotId, first.controls[0]!.ref)).toBeNull();
    url = targetUrl;
    const second = snapshot(forms);
    now = 60_000;
    expect(forms.resolve(second.snapshotId, second.controls[0]!.ref)).toBeNull();
    const third = snapshot(forms);
    forms.clear();
    expect(forms.resolve(third.snapshotId, third.controls[0]!.ref)).toBeNull();
  });

  it("fails closed on wrong document, wrong URL, HTTP and frames", () => {
    expect(registry().inspect({ ...message, documentId: "f".repeat(32) })).toEqual({ outcome: "stale-form" });
    expect(registry({ url: () => "https://other.example.com/" }).inspect(message)).toEqual({ outcome: "target-url-mismatch" });
    expect(registry({ url: () => "http://accounts.example.com/" }).inspect(message)).toEqual({ outcome: "insecure-origin" });
    expect(registry({ top: () => false }).inspect(message)).toEqual({ outcome: "not-top-frame" });
  });

  it("reports obstacles and never traverses embedded frames or closed shadow roots", () => {
    document.body.innerHTML = '<input type="email"><iframe></iframe><div data-sitekey="synthetic"></div><div role="combobox"></div><div id="host"></div>';
    document.getElementById("host")!.attachShadow({ mode: "closed" }).innerHTML = '<input type="password">';
    const forms = registry();
    const result = snapshot(forms);
    expect(result.controls).toHaveLength(1);
    expect(result.obstacles).toEqual(["embedded-frame", "captcha", "unsupported-control"]);
    forms.clear();
  });

  it("bounds the scan and discards incomplete snapshots", () => {
    document.body.innerHTML = '<input>'.repeat(65);
    const forms = registry();
    expect(forms.inspect(message)).toEqual({ outcome: "form-too-large" });
    document.body.innerHTML = '<input>';
    expect(snapshot(forms).controls).toHaveLength(1);
    forms.clear();
  });
});
