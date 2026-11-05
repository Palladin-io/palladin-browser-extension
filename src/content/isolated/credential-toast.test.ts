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

  it('opens native review without exposing account choices or saving from the page', async () => {
    send.mockResolvedValue({ status: 'accepted' });
    expect(shadow.textContent).not.toContain('Alice');
    expect(shadow.textContent).not.toContain('Personal');
    expect(shadow.querySelector('input,textarea,select')).toBeNull();
    expect(document.querySelector('palladin-capture')!.shadowRoot).toBeNull();
    await click('Review');
    expect(send).toHaveBeenCalledExactlyOnceWith({ channel: 'palladin.credential-capture', documentId: 'document-123456789', type: 'unlock' });
  });
  it('keeps review opening behind protected interaction checks', async () => {
    acceptsAction.mockReturnValue(false);
    await click('Review');
    expect(send).not.toHaveBeenCalled();
  });
  it('shows ambiguous username selection only in native review', () => {
    toast.show({ status: 'prompt', prompt: { ...view, targets: [], defaultTargetId: null, usernameSelection: { selected: null } } });
    expect(ui().queryByRole('radio')).toBeNull();
    expect(ui().getByRole('button', { name: 'Review' })).toBeVisible();
  });
  it('keeps an unavailable popup notice visible for manual toolbar opening', async () => {
    send.mockResolvedValue({ status: 'unavailable' });
    await click('Review');
    expect(ui().getByRole('button', { name: 'Review' })).toBeVisible();
    expect(ui().getByRole('alert')).toBeVisible();
  });
  it('dismisses using the worker-owned prompt ID', async () => {
    send.mockResolvedValue({ status: 'dismissed' });
    await click('Not now');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'dismiss', promptId: view.id }));
    expect(document.querySelector('palladin-capture')).toBeNull();
  });
  it('uses the same popup opening path while locked and exposes no account labels', async () => {
    toast.show({ status: 'prompt', prompt: { ...view, state: 'locked', targets: [], defaultTargetId: null } });
    send.mockResolvedValue({ status: 'accepted' });
    await click('Unlock Palladin');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'unlock' }));
    expect(shadow.textContent).not.toContain('Alice');
  });
  it('localizes the neutral notice and retains dark appearance', () => {
    toast.setAppearance('pl', 'dark');
    expect(ui().getByRole('button', { name: 'Sprawdź' })).toBeVisible();
    expect(document.querySelector('palladin-capture')).toHaveAttribute('data-theme', 'dark');
  });
  it('removes expired and stale notices', async () => {
    toast.show({ status: 'stale' });
    expect(document.querySelector('palladin-capture')).toBeNull();
    toast.show({ status: 'prompt', prompt: view });
    await vi.advanceTimersByTimeAsync(180000);
    expect(document.querySelector('palladin-capture')).toBeNull();
  });
});
