// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://accounts.example.com/login"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialSubmissionObserver, readSubmittedCredential } from "./credential-submission";

function form(markup: string): HTMLFormElement {
  document.body.innerHTML = `<form>${markup}<button>Continue</button></form>`;
  return document.querySelector("form")!;
}

const username = '<input autocomplete="username" value=" alice ">';
const current = '<input type="password" autocomplete="current-password" value="old">';
const next = '<input type="password" autocomplete="new-password" value=" new ">';

describe("submitted credential detection", () => {
  it("captures ordinary login and preserves literal passwords", () => {
    expect(readSubmittedCredential(form(username + '<input type="password" value=" p ">')))
      .toEqual({ kind: "login", username: "alice", password: " p ", previousPassword: null });
  });
  it("captures registration and password changes including confirmation fields", () => {
    expect(readSubmittedCredential(form(username + next + next)))
      .toEqual({ kind: "registration", username: "alice", password: " new ", previousPassword: null });
    expect(readSubmittedCredential(form(username + current + next + next)))
      .toEqual({ kind: "password-change", username: "alice", password: " new ", previousPassword: "old" });
  });
  it("accepts password change without username for a later explicit account choice", () => {
    expect(readSubmittedCredential(form(current + next))?.username).toBe("");
  });
  it("handles unannotated matching confirmation fields", () => {
    const plain = '<input type="password" value="new">';
    expect(readSubmittedCredential(form(username + plain + plain))?.kind).toBe("registration");
    expect(readSubmittedCredential(form(username + current + plain + plain))?.kind).toBe("password-change");
  });
  it.each([
    username + next + '<input type="password" autocomplete="new-password" value="different">',
    username + current + '<input type="password" value="unknown">',
    username + '<input type="password" value="">',
    username + '<div hidden>' + current + '</div>',
    username + '<div style="display:none">' + current + '</div>',
    username + '<input disabled type="password" value="hidden">',
    current,
  ])("rejects empty, hidden or ambiguous forms", (markup) => {
    expect(readSubmittedCredential(form(markup))).toBeNull();
  });
  it("includes controls associated via the form attribute", () => {
    const target = form(current);
    target.id = "login";
    document.body.insertAdjacentHTML("beforeend", '<input form="login" autocomplete="username" value="alice">');
    expect(readSubmittedCredential(target)?.username).toBe("alice");
  });
});

describe("submission outcome observation", () => {
  let observer: CredentialSubmissionObserver;
  const send = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    window.history.replaceState(null, "", "/login");
    observer = new CredentialSubmissionObserver(document, "document-123456789", send);
    observer.start();
  });
  afterEach(() => { observer.stop(); vi.useRealTimers(); document.body.innerHTML = ""; });

  it("does not read or send values for script-dispatched submit events", () => {
    form(username + current).dispatchEvent(new Event("submit", { bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });
  it("observes email, verification code and password on separate registration screens", async () => {
    observer.capture(form('<input type="email" autocomplete="email" value="alice@example.test">'));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "identifier", username: "alice@example.test" }));
    observer.capture(form('<input autocomplete="one-time-code" value="123456">'));
    expect(send).toHaveBeenCalledTimes(1);
    observer.capture(form(next));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "submitted",
      credential: { kind: "registration", username: "", password: " new ", previousPassword: null } }));
    document.querySelector("form")!.remove();
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "form-dismissed" }));
  });
  it.each(['<input autocomplete="one-time-code" value="123456">', '<input value="Alice">',
    '<input type="email" value="a@example.test"><input type="email" value="b@example.test">'])
  ("does not stage an OTP or ambiguous/unannotated identity step", (markup) => {
    observer.capture(form(markup));
    expect(send).not.toHaveBeenCalled();
  });
  it("sends a submission once and a value-free success after SPA form removal", async () => {
    const target = form(username + current);
    observer.capture(target);
    expect(send).toHaveBeenCalledTimes(1);
    target.remove();
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "outcome", outcome: "form-dismissed" }));
    expect(send.mock.calls[1]![0]).not.toHaveProperty("credential");
  });
  it("offers manual capture when a reused SPA form advances from password to personal details", async () => {
    const target = form(username + next);
    observer.capture(target);
    target.innerHTML = '<label>First name<input autocomplete="given-name"></label><button>Continue</button>';
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "form-dismissed" }));
  });
  it("does not mistake showing the submitted password as text for a completed step", async () => {
    const target = form(username + next);
    observer.capture(target);
    target.querySelector<HTMLInputElement>('input[type="password"]')!.type = "text";
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("recognizes successful password change without removing the form", async () => {
    observer.capture(form(username + current + next));
    document.body.insertAdjacentHTML("beforeend", '<div role="status">Password successfully updated.</div>');
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success-message" }));
  });
  it.each(["Incorrect password", "Password was not updated", "Nie zmieniono hasło"])("rejects failure: %s", async (text) => {
    observer.capture(form(username + current));
    document.body.insertAdjacentHTML("beforeend", `<div role="alert">${text}</div>`);
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "rejected" }));
  });
  it("does not use a stale success banner as evidence", async () => {
    const target = form(username + current + next);
    document.body.insertAdjacentHTML("beforeend", '<div role="status">Password updated</div>');
    observer.capture(target);
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not treat an MFA step with a visible password form as success", async () => {
    const target = form(username + current);
    observer.capture(target);
    target.remove();
    document.body.insertAdjacentHTML("beforeend", '<form><input type="password"></form>');
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not capture forms submitting credentials to another origin", () => {
    const target = form(username + current);
    target.action = "https://other.example.com/login";
    observer.capture(target);
    expect(send).not.toHaveBeenCalled();
  });
  it("expires pending observations", async () => {
    const target = form(username + current);
    observer.capture(target);
    await vi.advanceTimersByTimeAsync(180_001);
    target.remove();
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
