// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://tomojdom.pl/en/"}

import { afterEach, describe, expect, it, vi } from "vitest";
import { loginTargetFor, performBoundFill, performFill, performLoginTargetFill, submitFilledLoginTarget } from "./fill";
import { startInlineAutofill } from "./inline-autofill";
import type { FillField, InlineAutofillCommand } from "@shared/messaging";
import { readFileSync } from "node:fs";

declare const jsdom: { reconfigure(options: { url: string }): void };

const fields: FillField[] = [
  { kind: "username", value: "12345678" },
  { kind: "password", value: "fixture-password" },
];

function mount() {
  const base = 'tests/fixtures/forms/tomojdom-login-2026-10-04/';
  document.body.innerHTML = `<style>${readFileSync(base + 'page.css', 'utf8')}</style>${readFileSync(base + 'page.html', 'utf8')}`;
  return {
    username: document.querySelector('input[autocomplete="username email"]') as HTMLInputElement,
    password: document.querySelector('input[type="password"]') as HTMLInputElement,
    recovery: document.querySelector('input[autocomplete="email"]') as HTMLInputElement,
    step: document.querySelector('input[type="password"]')!.parentElement!.parentElement as HTMLElement,
    container: document.querySelector('.tmd-area') as HTMLElement,
  };
}

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("tomojdom staged form-less login", () => {
  it.each(["http://tomojdom.pl/", "https://other.tomojdom.pl/", "https://example.test/"])(
    "does not apply the exception at %s", (url) => {
      const { username } = mount();
      jsdom.reconfigure({ url });
      try { expect(loginTargetFor(username)).toBeNull(); }
      finally { jsdom.reconfigure({ url: "https://tomojdom.pl/en/" }); }
    },
  );

  it("automatically fills the identifier once without clicking any login method", async () => {
    const { username, password, container } = mount();
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => "en" } });
    const click = vi.fn();
    container.addEventListener("click", click);
    const send = vi.fn(async (command: { type: string; loginTargetId?: string }) => {
      if (command.type === "inline/list") return {
        ok: true, kind: "suggestions", status: "ready", entries: [{
          vaultId: "v1", entryId: "e1", name: "Fixture", username: "12345678",
          vaultName: "Test", urlDomain: "tomojdom.pl", updatedAt: "2026-10-04T00:00:00Z", match: "exact",
        }],
      };
      const target = subject.resolveLoginTarget(command.loginTargetId!);
      const result = performLoginTargetFill(target!, fields);
      return { ok: true, kind: "fill", status: result.ok ? "filled" : "no-form" };
    });
    const subject = startInlineAutofill(document, "a".repeat(32), send);
    try {
      await vi.waitFor(() => expect(username.value).toBe("12345678"));
      subject.retryAutomaticFill();
      await Promise.resolve();
      expect(send.mock.calls.filter(([command]) => command.type === "inline/fill")).toHaveLength(1);
      expect(password.value).toBe("");
      expect(click).not.toHaveBeenCalled();
    } finally { subject.stop(); }
  });

  it.each(['same-account', 'changed-account', 'replaced-username', 'replaced-panel', 'navigation', 'lock', 'lock-pending', 'different-entry', 'different-suggestion-account', 'related-entry', 'prefilled'])(
    'continues automatic identifier fill only for the bound same-account flow: %s', async (variant) => {
      const { username, password, step, container } = mount();
      vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => "en" } });
      if (variant === 'prefilled') username.value = '12345678';
      let passwordStage = false;
      const clicked = vi.fn(); container.addEventListener('click', clicked);
      const send = vi.fn(async (command: InlineAutofillCommand) => {
        if (command.type === 'inline/list' && passwordStage && variant === 'lock-pending') subject.clearSessionState();
        if (command.type === 'inline/list') return {
          ok: true, kind: 'suggestions', status: 'ready', entries: [{
            vaultId: 'v1', entryId: passwordStage && variant === 'different-entry' ? 'e2' : 'e1',
            name: 'Fixture', username: passwordStage && variant === 'different-suggestion-account' ? '87654321' : '12345678', vaultName: 'Test', urlDomain: 'tomojdom.pl',
            updatedAt: '2026-10-04T00:00:00Z', match: passwordStage && variant === 'related-entry' ? 'related' : 'exact',
          }],
        };
        if (command.type !== 'inline/fill') throw new Error('Unexpected command');
        const target = subject.resolveLoginTarget(command.loginTargetId);
        const result = target ? performLoginTargetFill(target, fields, 'automatic') : { ok: false };
        return { ok: true, kind: 'fill', status: result.ok ? 'filled' : 'no-form' };
      });
      const subject = startInlineAutofill(document, 'a'.repeat(32), send);
      try {
        if (variant !== 'prefilled') await vi.waitFor(() => expect(username.value).toBe('12345678'));
        // Let the initial worker reply complete before exposing the next stage.
        await Promise.resolve(); await Promise.resolve();
        passwordStage = true;
        if (variant === 'changed-account') username.value = '87654321';
        if (variant === 'replaced-username') {
          const replacement = username.cloneNode() as HTMLInputElement;
          replacement.value = username.value; username.replaceWith(replacement);
        }
        if (variant === 'navigation') jsdom.reconfigure({ url: 'https://tomojdom.pl/other-page' });
        if (variant === 'lock') subject.clearSessionState();
        if (variant === 'replaced-panel') {
          const replacement = container.cloneNode(false) as HTMLElement;
          replacement.append(...container.childNodes); container.replaceWith(replacement);
        }
        step.classList.remove('d-none');
        if (variant === 'same-account') await vi.waitFor(() => expect(password.value).toBe('fixture-password'));
        else await new Promise(resolve => setTimeout(resolve, 160));
        expect(password.value).toBe(variant === 'same-account' ? 'fixture-password' : '');
        subject.retryAutomaticFill();
        await Promise.resolve();
        expect(send.mock.calls.filter(([command]) => command.type === 'inline/fill')).toHaveLength(
          variant === 'prefilled' ? 0 : variant === 'same-account' ? 2 : 1,
        );
        expect(clicked).not.toHaveBeenCalled();
      } finally { subject.stop(); jsdom.reconfigure({ url: 'https://tomojdom.pl/en/' }); }
    },
  );

  it("fills only the initial identifier from the popup and not hidden password/recovery", () => {
    const { username, password, recovery, container } = mount();
    const click = vi.fn();
    container.addEventListener("click", click);
    expect(loginTargetFor(username)).toMatchObject({ username, password: null, form: container });
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect(username.value).toBe("12345678");
    expect(password.value).toBe("");
    expect(recovery.value).toBe("");
    expect(click).not.toHaveBeenCalled();
  });

  it("moves the inline launcher when the site reveals the password and fills the same account", async () => {
    const { username, password, step, recovery } = mount();
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } }, i18n: { getUILanguage: () => "en" } });
    const send = vi.fn(async () => ({ ok: true, kind: "suggestions", status: "ready", entries: [] }));
    const subject = startInlineAutofill(document, "a".repeat(32), send);
    try {
      expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
      const initialLauncher = document.querySelector("palladin-autofill");
      const initial = loginTargetFor(username)!;
      expect(performLoginTargetFill(initial, fields)).toEqual({ ok: true });
      expect(password.value).toBe("");
      step.classList.remove("d-none");
      await vi.waitFor(() => {
        expect(document.querySelectorAll("palladin-autofill")).toHaveLength(1);
        expect(document.querySelector("palladin-autofill")).not.toBe(initialLauncher);
      });
      expect(loginTargetFor(username)).toBeNull();
      const target = loginTargetFor(password)!;
      expect(target).not.toBeNull();
      expect(performLoginTargetFill(target, [{ kind: "username", value: "87654321" }, fields[1]!]))
        .toEqual({ ok: false, reason: "no-form" });
      expect(password.value).toBe("");
      expect(performLoginTargetFill(target, fields)).toEqual({ ok: true });
      expect(password.value).toBe("fixture-password");
      expect(recovery.value).toBe("");
      expect(performLoginTargetFill(target, fields)).toEqual({ ok: true });
    } finally { subject.stop(); }
  });

  it("fills and submits the visible password step through the explicit login action", async () => {
    const { username, password, step } = mount();
    username.value = "12345678";
    step.classList.remove("d-none");
    const action = step.querySelector("button")!;
    const clicked = vi.fn();
    action.addEventListener("click", clicked);
    const target = loginTargetFor(password)!;
    expect(performLoginTargetFill(target, fields, "manual")).toEqual({ ok: true });
    expect(await submitFilledLoginTarget(target, () => true)).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate", "disabled", "moved", "foreign-form"])("does not submit another action when the password login button is %s", async (mutation) => {
    const { username, password, step, container } = mount();
    username.value = "12345678";
    step.classList.remove("d-none");
    const action = step.querySelector("button")!;
    const clicked = vi.fn();
    container.addEventListener("click", clicked);
    if (mutation === "missing") action.remove();
    if (mutation === "duplicate") action.after(action.cloneNode(true));
    if (mutation === "disabled") action.disabled = true;
    if (mutation === "moved") container.append(action);
    if (mutation === "foreign-form") {
      const form = document.createElement("form");
      form.id = "other-form";
      document.body.append(form);
      action.setAttribute("form", form.id);
    }
    const target = loginTargetFor(password)!;
    expect(performLoginTargetFill(target, fields, "manual")).toEqual({ ok: true });
    expect(await submitFilledLoginTarget(target, () => true)).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });

  it("leaves the password hidden for the email/code method", () => {
    const { username, password } = mount();
    expect(performFill(document, [{ kind: "username", value: "fixture@example.com" }, fields[1]!]))
      .toEqual({ ok: true });
    expect(username.value).toBe("fixture@example.com");
    expect(password.value).toBe("");
    expect(loginTargetFor(password)).toBeNull();
  });

  it("fills an already visible password step from the popup", () => {
    const { username, password, step } = mount();
    username.value = "12345678";
    step.classList.remove("d-none");
    expect(performFill(document, fields)).toEqual({ ok: true });
    expect(username.value).toBe("12345678");
    expect(password.value).toBe("fixture-password");
  });

  it("rechecks the account after page input handlers run", () => {
    const { username, password, step } = mount();
    username.addEventListener("change", () => { username.value = "87654321"; step.classList.remove("d-none"); });
    expect(performFill(document, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(password.value).toBe("");
  });

  it("rejects stale targets after replacement of the owning panel", () => {
    const { username, container } = mount();
    const target = loginTargetFor(username)!;
    expect(target).not.toBeNull();
    const replacement = document.createElement("div");
    replacement.className = "tmd-area";
    replacement.append(...container.childNodes);
    container.replaceWith(replacement);
    expect(performLoginTargetFill(target, fields)).toEqual({ ok: false, reason: "no-form" });
    expect(username.value).toBe("");
  });

  it("rejects ambiguous panels, recovery fields and cross-panel password pairing", () => {
    const { username, password, recovery } = mount();
    expect(loginTargetFor(recovery)).toBeNull();
    password.parentElement!.append(password.cloneNode());
    expect(loginTargetFor(username)).toBeNull();
    password.parentElement!.lastElementChild!.remove();
    document.body.append(password);
    expect(loginTargetFor(username)).toBeNull();
  });

  it("retains the final origin and document gates", () => {
    const { username } = mount();
    const target = loginTargetFor(username)!;
    expect(target).not.toBeNull();
    const message = { channel: "palladin.fill/request" as const, documentId: "doc", expectedOrigin: "https://tomojdom.pl", expectedDomain: "tomojdom.pl", loginTargetId: "login-1", fields, submit: false, intent: "automatic" as const };
    expect(performBoundFill(document, message, "https://other.tomojdom.pl/", "doc", target))
      .toEqual({ ok: false, reason: "target-changed" });
    expect(performBoundFill(document, message, location.href, "other-doc", target))
      .toEqual({ ok: false, reason: "target-changed" });
    expect(username.value).toBe("");
  });

  it.each(['identifier', 'password'])('rejects a %s target adopted into another same-origin document', (stage) => {
    const { username, password, step } = mount();
    if (stage === 'password') {
      username.value = '12345678';
      step.classList.remove('d-none');
    }
    const target = loginTargetFor(stage === 'identifier' ? username : password)!;
    expect(target).not.toBeNull();
    const frame = document.createElement('iframe');
    frame.src = 'https://tomojdom.pl/other-document';
    document.body.append(frame);
    const other = frame.contentDocument!;
    other.open(); other.write('<!doctype html><html><body></body></html>'); other.close();
    other.head.append(document.querySelector('style')!.cloneNode(true));
    other.body.append(other.adoptNode(document.querySelector('#modules')!));
    expect(password.ownerDocument).toBe(other);
    expect(loginTargetFor(stage === 'identifier' ? username : password)).not.toBeNull();
    const message = { channel: 'palladin.fill/request' as const, documentId: 'doc', expectedOrigin: 'https://tomojdom.pl',
      expectedDomain: 'tomojdom.pl', loginTargetId: 'login-1', fields, submit: false, intent: 'manual' as const };
    expect(performBoundFill(document, message, location.href, 'doc', target)).toEqual({ ok: false, reason: 'no-form' });
    const foreignTarget = loginTargetFor(stage === 'identifier' ? username : password)!;
    expect(performBoundFill(document, message, location.href, 'doc', foreignTarget))
      .toEqual({ ok: false, reason: 'target-changed' });
    expect(password.value).toBe('');
    expect(username.value).toBe(stage === 'password' ? '12345678' : '');
  });
});
