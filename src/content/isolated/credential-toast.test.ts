// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import { CredentialCaptureToast } from "./credential-toast";
import type { CredentialCapturePrompt } from "@shared/messaging/credential-capture";

const acceptsAction = vi.hoisted(() => vi.fn());
vi.mock("./closed-surface", async (importOriginal) => {
  const original = await importOriginal<typeof import("./closed-surface")>();
  return { createClosedSurface: (...args: Parameters<typeof original.createClosedSurface>) =>
    ({ ...original.createClosedSurface(...args), acceptsAction }) };
});

const view: CredentialCapturePrompt = {
  id: "prompt-1234567890", site: "example.com", state: "ready", defaultTargetId: "target-update-12345",
  targets: [
    { id: "target-create-12345", action: "create", label: "Personal", vaultLabel: "Personal" },
    { id: "target-update-12345", action: "update", label: "Alice", vaultLabel: "Personal" },
    { id: "target-other-123456", action: "create", label: "Team", vaultLabel: "Team" },
  ],
};

describe("credential capture toast", () => {
  let toast: CredentialCaptureToast;
  let shadow: ShadowRoot;
  const send = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset().mockResolvedValue({ status: "saved", action: "updated" });
    acceptsAction.mockReset().mockReturnValue(true);
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
      shadow = attach.call(this, options);
      return shadow;
    });
    toast = new CredentialCaptureToast(document, "document-123456789", send);
    toast.show({ status: "prompt", prompt: view });
  });
  afterEach(() => { toast.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const ui = () => within(shadow as unknown as HTMLElement);
  async function click(name: string | RegExp) {
    ui().getByRole("button", { name }).click();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("uses a closed root, no text inputs and a default-off account checkbox", () => {
    expect(document.querySelector("palladin-capture")!.shadowRoot).toBeNull();
    expect(shadow.querySelector("input, textarea")).toBeNull();
    expect(ui().getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    expect(ui().getByRole("button", { name: "Update Alice" })).toBeVisible();
    expect(ui().queryByRole("button", { name: "Save in Team" })).toBeNull();
  });
  it("updates with one click without opening a popup", async () => {
    await click("Update Alice");
    expect(send).toHaveBeenCalledExactlyOnceWith({ channel: "palladin.credential-capture",
      documentId: "document-123456789", type: "save", promptId: view.id,
      targetId: view.defaultTargetId, autoUpdate: false });
    expect(ui().getByRole("status")).toHaveTextContent("Password updated");
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector("palladin-capture")).toBeNull();
  });
  it("records opt-in with Update, not when toggling the checkbox", async () => {
    ui().getByRole("checkbox").click();
    expect(send).not.toHaveBeenCalled();
    expect(ui().getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    expect(ui().getByRole("checkbox")).toHaveAttribute("aria-label", "Automatically update passwords for this account");
    await click("Update Alice");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ autoUpdate: true }));
  });
  it("allows choosing another writable vault and drops the account checkbox", async () => {
    await click("Change...");
    await click("Save in Team");
    expect(ui().queryByRole("checkbox")).toBeNull();
    await click("Save in Team");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: "target-other-123456", autoUpdate: false }));
  });
  it("shows the vault beside an existing Entry before choosing it", async () => {
    await click("Change...");
    expect(ui().getByRole("button", { name: "Update Alice Personal" })).toHaveTextContent("Personal");
    await click("Update Alice Personal");
    expect(send).not.toHaveBeenCalled();
    await click("Update Alice");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: "target-update-12345" }));
  });
  it("does not send commands when the protected surface rejects an interaction", async () => {
    acceptsAction.mockReturnValue(false);
    await click("Update Alice");
    expect(send).not.toHaveBeenCalled();
  });
  it("shows a retryable error without resetting the chosen target", async () => {
    send.mockResolvedValue({ status: "unavailable" });
    await click("Update Alice");
    expect(ui().getByRole("alert")).toHaveTextContent("Could not save. Try again.");
    expect(ui().getByRole("button", { name: "Update Alice" })).toBeEnabled();
  });
  it.each(["Not now", "Dismiss save suggestion", "Don't ask for this site"])("dismisses with one click: %s", async (name) => {
    send.mockResolvedValue({ status: "dismissed" });
    await click(name);
    expect(send.mock.calls[0]![0].type).toBe(name === "Don't ask for this site" ? "mute" : "dismiss");
    expect(document.querySelector("palladin-capture")).toBeNull();
  });
  it("unlocks from the locked prompt without exposing account labels", async () => {
    toast.show({ status: "prompt", prompt: { ...view, state: "locked", targets: [], defaultTargetId: null } });
    expect(ui().queryByText("Alice")).toBeNull();
    await click("Unlock Palladin");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "unlock" }));
  });
  it("renders Polish copy and explicit dark mode", () => {
    toast.setAppearance("pl", "dark");
    expect(document.querySelector("palladin-capture")).toHaveAttribute("data-theme", "dark");
    expect(ui().getByRole("button", { name: "Aktualizuj Alice" })).toBeVisible();
    expect(ui().getByRole("checkbox")).toHaveTextContent("Automatycznie aktualizuj hasło dla tego konta");
  });
  it("shows a failed automatic update as a manual confirmation with the checkbox reset", () => {
    ui().getByRole("checkbox").click();
    toast.show({ status: "prompt", prompt: { ...view, error: "save-failed", defaultTargetId: "refreshed-target-123",
      targets: [{ ...view.targets[1]!, id: "refreshed-target-123" }] } });
    expect(ui().getByRole("alert")).toBeVisible();
    expect(ui().getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    expect(ui().getByRole("button", { name: "Update Alice" })).toBeEnabled();
  });
  it("shows an unlock failure in the locked prompt", async () => {
    send.mockResolvedValue({ status: "unavailable" });
    toast.show({ status: "prompt", prompt: { ...view, state: "locked", targets: [], defaultTargetId: null } });
    await click("Unlock Palladin");
    expect(ui().getByRole("alert")).toBeVisible();
  });
  it("never interprets entry labels as HTML", () => {
    toast.show({ status: "prompt", prompt: { ...view, targets: [
      { ...view.targets[1]!, label: '<img src=x onerror="alert(1)">' },
    ] } });
    expect(shadow.querySelector("img[onerror]")).toBeNull();
    expect(ui().getByRole("button", { name: 'Update <img src=x onerror="alert(1)">' })).toBeVisible();
  });
});
