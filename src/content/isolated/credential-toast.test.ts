// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import { CredentialCaptureToast } from "./credential-toast";
import type { CredentialCapturePrompt } from "@shared/messaging/credential-capture";

const openReview = vi.hoisted(() => vi.fn());
vi.mock('./capture-review-host', () => ({ openInlineCaptureReview: openReview }));
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
    openReview.mockReset().mockResolvedValue(true);
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
      shadow = attach.call(this, options);
      return shadow;
    });
    toast = new CredentialCaptureToast(document, "document-123456789", send);
    toast.show({ status: "prompt", prompt: view });
  });
  afterEach(() => { toast.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
  const ui = () => within(shadow.querySelector('.panel') as HTMLElement);
  async function click(name: string | RegExp) {
    ui().getByRole("button", { name }).click();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('keeps the branded header separate from the two review actions and site mute', () => {
    expect(shadow.querySelector('.notice-brand')?.textContent).toBe('Palladin.io');
    expect(shadow.querySelector('.notice-brand img')).not.toBeNull();
    expect(shadow.querySelector('.footer')?.children).toHaveLength(2);
    expect(ui().queryByRole('button', { name: /Don't offer/ })).toBeNull();
    expect(ui().getByRole('button', { name: 'More dismiss options' })).toHaveAttribute('aria-expanded','false');
  });
  it('opens scoped inline review without invoking native popup', async () => {
    send.mockResolvedValue({ status: 'accepted' });
    expect(shadow.textContent).not.toContain('Alice');
    expect(shadow.textContent).not.toContain('Personal');
    expect(shadow.querySelector('input,textarea,select')).toBeNull();
    expect(document.querySelector('palladin-capture')!.shadowRoot).toBeNull();
    await click('Review');
    expect(send).not.toHaveBeenCalled();
    expect(openReview).toHaveBeenCalledWith(document, 'document-123456789', 'login', view.id, expect.objectContaining({onReady:expect.any(Function)}));
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
  it.each(['en', 'pl'] as const)('keeps a failed inline review visible for retry in %s', async locale => {
    toast.setAppearance(locale, 'light');
    openReview.mockResolvedValue(false);
    const label = locale === 'pl' ? 'Sprawdź' : 'Review';
    await click(label);
    expect(ui().getByRole('button', { name: label })).toBeVisible();
    expect(ui().getByRole('alert')).toHaveTextContent(locale === 'pl' ? 'Nie udało' : 'Could not');
  });
  it('reveals site mute from Dismiss without dispatching an action', async () => {
    send.mockResolvedValue({ status: 'dismissed' });
    await click('More dismiss options');
    expect(send).not.toHaveBeenCalled();
    expect(shadow.querySelector('.site-preference')).not.toHaveAttribute('hidden');
    (shadow.querySelector('.site-mute') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'mute', promptId: view.id }));
    expect(document.querySelector('palladin-capture')).toBeNull();
  });
  it('dismisses using the worker-owned prompt ID', async () => {
    send.mockResolvedValue({ status: 'dismissed' });
    await click('Dismiss');
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
