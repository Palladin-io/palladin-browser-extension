import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_CAPTURE_CHANNEL, type CredentialCaptureCommand, type CredentialCaptureResult } from "@shared/messaging/credential-capture";
import {
  CredentialCaptureCoordinator,
  type CaptureSession,
  type CredentialCaptureChoices,
  type CredentialCaptureSource,
  type CredentialWriteTarget,
} from "./credential-coordinator";

const source: CredentialCaptureSource = {
  tabId: 1, browserDocumentId: "browser-document-1", documentId: "isolated-document-1",
  url: "https://accounts.example.com/login",
};
const createTarget: CredentialWriteTarget = { action: "create", vaultId: "personal", label: "Personal", vaultLabel: "Personal" };
const updateTarget: CredentialWriteTarget = {
  action: "update", vaultId: "personal", entryId: "alice-entry", revision: "4", label: "Alice",
  vaultLabel: "Personal", exactAccount: true, previousPasswordMatches: true,
};
const command = <T extends Omit<CredentialCaptureCommand, "channel" | "documentId">>(value: T) =>
  ({ ...value, channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: source.documentId }) as CredentialCaptureCommand;
const submitted = command({ type: "submitted", submissionId: "submission-123456789",
  credential: { kind: "password-change", username: "alice", password: "new", previousPassword: "old" } });
const confirmed = command({ type: "outcome", submissionId: "submission-123456789", outcome: "success-message" });

function prompt(result: CredentialCaptureResult) {
  expect(result.status).toBe("prompt");
  if (result.status !== "prompt" || !result.prompt) throw new Error("Expected prompt");
  return result.prompt;
}

describe("credential capture worker", () => {
  let coordinator: CredentialCaptureCoordinator;
  let session: CaptureSession | null;
  let choices: CredentialCaptureChoices;
  const preferences = { isMuted: vi.fn(), mute: vi.fn(), isAutomatic: vi.fn(), setAutomatic: vi.fn() };
  const save = vi.fn();
  const isCurrentDocument = vi.fn();
  const isSubmissionDocument = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    session = { profileId: "api:user", generation: 1, unlocked: true };
    choices = { identical: false, targets: [createTarget, updateTarget], defaultIndex: 1 };
    isCurrentDocument.mockResolvedValue(true);
    isSubmissionDocument.mockReturnValue(true);
    preferences.isMuted.mockResolvedValue(false);
    preferences.isAutomatic.mockResolvedValue(false);
    save.mockResolvedValue({ action: "updated", revision: "5" });
    coordinator = new CredentialCaptureCoordinator({
      getSession: async () => session, isCurrentDocument, isSubmissionDocument,
      choices: async () => choices, save, preferences,
    });
  });
  afterEach(() => { coordinator.clear(); vi.useRealTimers(); });

  async function ready() {
    expect(await coordinator.dispatch(submitted, source)).toEqual({ status: "accepted" });
    return prompt(await coordinator.dispatch(confirmed, source));
  }

  it("joins email and password across two same-origin registration documents without saving early", async () => {
    await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "alice@example.test" }), source);
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
    const nextSource = { ...source, browserDocumentId: "browser-password", documentId: "isolated-password", url: "https://accounts.example.com/password" };
    for (const id of ["browser-verification", nextSource.browserDocumentId]) {
      coordinator.navigationStarted(source.tabId);
      coordinator.navigation(source.tabId, nextSource.url);
      coordinator.documentConnected(source.tabId, id, nextSource.url);
    }
    await coordinator.dispatch({ ...command({ type: "submitted", submissionId: "submission-123456789",
      credential: { kind: "registration", username: "", password: "new", previousPassword: null } }), documentId: nextSource.documentId }, nextSource);
    const view = prompt(await coordinator.dispatch({ ...confirmed, documentId: nextSource.documentId }, nextSource));
    expect(save).not.toHaveBeenCalled();
    await coordinator.dispatch({ ...command({ type: "save", promptId: view.id, targetId: view.defaultTargetId!, autoUpdate: false }),
      documentId: nextSource.documentId }, nextSource);
    expect(save.mock.calls[0]![0]).toEqual({ kind: "registration", username: "alice@example.test", password: "new", previousPassword: null });
  });

  it.each(["expiry", "lock", "tab-close", "cross-origin", "account-switch", "rejection", "other-tab"])
  ("does not reuse the previous email after %s", async (reason) => {
    await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "alice@example.test" }), source);
    if (reason === "expiry") await vi.advanceTimersByTimeAsync(180_001);
    if (reason === "lock") coordinator.clear();
    if (reason === "tab-close") coordinator.clearTab(source.tabId);
    if (reason === "cross-origin") {
      coordinator.navigation(source.tabId, "https://other.example.com/");
      coordinator.navigation(source.tabId, source.url);
    }
    if (reason === "account-switch") session = { profileId: "api:other", unlocked: true, generation: 2 };
    if (reason === "rejection") await coordinator.dispatch(command({ type: "outcome", submissionId: "identifier-123456789", outcome: "rejected" }), source);
    const targetSource = reason === "other-tab" ? { ...source, tabId: 2 } : source;
    const result = await coordinator.dispatch(command({ type: "submitted", submissionId: "submission-123456789",
      credential: { kind: "registration", username: "", password: "new", previousPassword: null } }), targetSource);
    expect(["stale", "unavailable"]).toContain(result.status);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not renew the identity lifetime when a password arrives", async () => {
    await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "alice@example.test" }), source);
    await vi.advanceTimersByTimeAsync(179_000);
    await coordinator.dispatch(command({ type: "submitted", submissionId: "submission-123456789",
      credential: { kind: "registration", username: "", password: "new", previousPassword: null } }), source);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "prompt", prompt: null });
  });

  it("prefers an explicit current account and consumes rather than reuses the earlier identity", async () => {
    await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "previous@example.test" }), source);
    await coordinator.dispatch(submitted, source);
    const view = prompt(await coordinator.dispatch(confirmed, source));
    await coordinator.dispatch(command({ type: "save", promptId: view.id, targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(save.mock.calls[0]![0].username).toBe("alice");
    expect(await coordinator.dispatch(command({ type: "submitted", submissionId: "submission-123456789",
      credential: { kind: "registration", username: "", password: "new", previousPassword: null } }), source)).toEqual({ status: "stale" });
  });

  it("does not stage a muted or unauthenticated identity", async () => {
    preferences.isMuted.mockResolvedValue(true);
    expect(await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "alice@example.test" }), source))
      .toEqual({ status: "dismissed" });
    isSubmissionDocument.mockReturnValue(false);
    expect(await coordinator.dispatch(command({ type: "identifier", submissionId: "identifier-123456789", username: "alice@example.test" }), source))
      .toEqual({ status: "stale" });
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
  });

  it("does not propose or save before an outcome", async () => {
    await coordinator.dispatch(submitted, source);
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
    expect(save).not.toHaveBeenCalled();
  });
  it('does not erase a fast SPA prompt when the initial resume probe arrives later', async () => {
    await ready();
    expect(await coordinator.dispatch(command({ type: 'resume', hasPasswordForm: false,
      hasError: false, hasSuccess: true }), source)).toEqual({ status: 'accepted' });
    expect(prompt(await coordinator.dispatch(command({ type: 'get' }), source)).state).toBe('ready');
  });
  it('does not erase the success toast when the initial resume probe arrives after saving', async () => {
    const view = await ready();
    await coordinator.dispatch(command({ type: 'save', promptId: view.id, targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(await coordinator.dispatch(command({ type: 'resume', hasPasswordForm: false,
      hasError: false, hasSuccess: true }), source)).toEqual({ status: 'accepted' });
  });
  it("returns value-free targets and saves on a single confirmed click", async () => {
    const view = await ready();
    expect(JSON.stringify(view)).not.toContain('"password"');
    expect(JSON.stringify(view)).not.toContain('"username"');
    const result = await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(result).toEqual({ status: "saved", action: "updated" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
  });
  it("retains a ready capture after a same-document SPA URL change", async () => {
    await coordinator.dispatch(submitted, source);
    const view = prompt(await coordinator.dispatch(command({ type: "outcome", submissionId: "submission-123456789", outcome: "form-dismissed" }), source));
    const nextSource = { ...source, url: "https://accounts.example.com/personal-details" };
    coordinator.navigation(source.tabId, nextSource.url);
    coordinator.navigationUpdated(source.tabId, "loading");
    coordinator.navigationUpdated(source.tabId, "complete");
    const result = await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), nextSource);
    expect(result).toEqual({ status: "saved", action: "updated" });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it.each(["navigation-started", "new-document", "cross-origin"])("invalidates a ready capture after %s", async (reason) => {
    const view = await ready();
    if (reason === "navigation-started") coordinator.navigationStarted(source.tabId);
    if (reason === "new-document") coordinator.documentConnected(source.tabId, "next-browser-document", source.url);
    if (reason === "cross-origin") coordinator.navigation(source.tabId, "https://other.example.com/home");
    await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(save).not.toHaveBeenCalled();
  });
  it.each(["loading", "complete"])("clears a ready capture after %s without a live content document", async (status) => {
    const view = await ready();
    isSubmissionDocument.mockReturnValue(false);
    coordinator.navigationUpdated(source.tabId, status);
    await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(save).not.toHaveBeenCalled();
  });
  it("lets users select a new vault instead of the suggested update", async () => {
    const view = await ready();
    const targetId = view.targets.find((target) => target.action === "create")!.id;
    await coordinator.dispatch(command({ type: "save", promptId: view.id, targetId, autoUpdate: false }), source);
    expect(save.mock.calls[0]![2]).toEqual(createTarget);
  });
  it("rejects a target not offered in the extension-owned prompt", async () => {
    const view = await ready();
    expect(await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: "invented-target-123456789", autoUpdate: false }), source)).toEqual({ status: "stale" });
    expect(save).not.toHaveBeenCalled();
  });
  it("prevents duplicate writes from double clicks", async () => {
    const view = await ready();
    const click = command({ type: "save", promptId: view.id, targetId: view.defaultTargetId!, autoUpdate: false });
    await Promise.all([coordinator.dispatch(click, source), coordinator.dispatch(click, source)]);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("does not offer identical credentials", async () => {
    choices = { ...choices, identical: true };
    await coordinator.dispatch(submitted, source);
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "dismissed" });
    expect(save).not.toHaveBeenCalled();
  });
  it.each(["dismiss", "mute"] as const)("clears credentials on %s without mutation", async (type) => {
    const view = await ready();
    await coordinator.dispatch(command({ type, promptId: view.id }), source);
    expect(save).not.toHaveBeenCalled();
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
    if (type === "mute") expect(preferences.mute).toHaveBeenCalledWith("api:user", "example.com");
  });
  it("rejects failed submissions and respects muted domains", async () => {
    await coordinator.dispatch(submitted, source);
    await coordinator.dispatch(command({ type: "outcome", submissionId: "submission-123456789", outcome: "rejected" }), source);
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "prompt", prompt: null });
    preferences.isMuted.mockResolvedValue(true);
    expect(await coordinator.dispatch(submitted, source)).toEqual({ status: "dismissed" });
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps a locked pending capture in memory and presents targets after unlock", async () => {
    session = { ...session!, unlocked: false };
    const locked = await ready();
    expect(locked).toMatchObject({ state: "locked", targets: [], defaultTargetId: null });
    session = { ...session!, unlocked: true, generation: 2 };
    const unlocked = prompt(await coordinator.dispatch(command({ type: "get" }), source));
    expect(unlocked.state).toBe("ready");
    expect(unlocked.targets).toHaveLength(2);
  });
  it("clears captures on profile switch and expires them even without further interaction", async () => {
    await ready();
    session = { ...session!, profileId: "api:other" };
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
    await ready();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await coordinator.dispatch(command({ type: "get" }), source)).toEqual({ status: "prompt", prompt: null });
  });
  it("binds every command to the browser document, isolated document and origin", async () => {
    await ready();
    for (const patch of [{ browserDocumentId: "other" }, { url: "http://accounts.example.com" },
      { documentId: "other-document-123456" }, { url: "https://evil.example.com" }]) {
      const result = await coordinator.dispatch(command({ type: "get" }), { ...source, ...patch });
      expect(result.status).toBe("stale");
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("cancels pending values on cross-origin navigation and tab close", async () => {
    await coordinator.dispatch(submitted, source);
    coordinator.navigation(source.tabId, "https://other.example.com");
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "prompt", prompt: null });
    await coordinator.dispatch(submitted, source);
    coordinator.clearTab(source.tabId);
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "prompt", prompt: null });
  });
  it("resumes a classic same-origin navigation without auto update", async () => {
    preferences.isAutomatic.mockResolvedValue(true);
    await coordinator.dispatch(submitted, source);
    coordinator.navigation(source.tabId, "https://accounts.example.com/home");
    const nextSource = { ...source, browserDocumentId: "next-browser-document", documentId: "next-isolated-document" };
    const resumed = prompt(await coordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL,
      documentId: nextSource.documentId, type: "resume", hasPasswordForm: false, hasError: false, hasSuccess: false }, nextSource));
    expect(resumed.state).toBe("ready");
    expect(save).not.toHaveBeenCalled();
    expect((await coordinator.dispatch(command({ type: "get" }), source)).status).toBe("stale");
  });
  it('retains a ready classic capture when the same successor reconnects its port', async () => {
    await coordinator.dispatch(submitted, source);
    coordinator.navigationStarted(source.tabId);
    const next = { ...source, browserDocumentId: 'next-browser-document', documentId: 'next-isolated-document' };
    coordinator.documentConnected(next.tabId, next.browserDocumentId, next.url);
    isSubmissionDocument.mockImplementation((candidate) => candidate.browserDocumentId === next.browserDocumentId);
    coordinator.navigationUpdated(next.tabId, "complete");
    const resumed = prompt(await coordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL,
      documentId: next.documentId, type: 'resume', hasPasswordForm: false, hasError: false, hasSuccess: true }, next));
    coordinator.documentConnected(next.tabId, next.browserDocumentId, next.url);
    coordinator.navigationUpdated(next.tabId, "loading");
    coordinator.navigationUpdated(next.tabId, "complete");
    expect(await coordinator.dispatch({ ...command({ type: 'save', promptId: resumed.id,
      targetId: resumed.defaultTargetId!, autoUpdate: false }), documentId: next.documentId }, next))
      .toEqual({ status: 'saved', action: 'updated' });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it.each(['cross-origin', 'second-document', 'browser-page-hop'])('never resumes a capture after an intervening %s', async (reason) => {
    await coordinator.dispatch(submitted, source);
    coordinator.navigationStarted(source.tabId);
    if (reason === 'cross-origin') coordinator.documentConnected(source.tabId, 'next', 'https://other.example.com');
    if (reason === 'second-document') {
      coordinator.documentConnected(source.tabId, 'next', source.url);
      coordinator.documentConnected(source.tabId, 'third', source.url);
    }
    if (reason === 'browser-page-hop') coordinator.navigationStarted(source.tabId);
    const next = { ...source, browserDocumentId: 'returned', documentId: 'returned-isolated-doc' };
    expect(await coordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: next.documentId,
      type: 'resume', hasPasswordForm: false, hasSuccess: true, hasError: false }, next)).toEqual({ status: 'accepted' });
    expect(save).not.toHaveBeenCalled();
  });
  it("retains an admitted submit when navigation wins the asynchronous preference read", async () => {
    let resolveMuted!: (muted: boolean) => void;
    preferences.isMuted.mockImplementation(() => new Promise<boolean>((resolve) => { resolveMuted = resolve; }));
    const admission = coordinator.dispatch(submitted, source);
    await vi.waitFor(() => expect(preferences.isMuted).toHaveBeenCalled());
    isCurrentDocument.mockResolvedValue(false);
    coordinator.navigation(source.tabId, "https://accounts.example.com/home");
    resolveMuted(false);
    expect(await admission).toEqual({ status: "accepted" });
    isCurrentDocument.mockResolvedValue(true);
    const nextSource = { ...source, browserDocumentId: "next-browser-document", documentId: "next-isolated-document" };
    expect(prompt(await coordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL,
      documentId: nextSource.documentId, type: "resume", hasPasswordForm: false, hasError: false, hasSuccess: false }, nextSource)).state).toBe("ready");
  });
  it.each(["close", "lock", "cross-origin", "expiry"])("never resurrects a submission after %s during admission", async (reason) => {
    let resolveMuted!: (muted: boolean) => void;
    preferences.isMuted.mockImplementation(() => new Promise<boolean>((resolve) => { resolveMuted = resolve; }));
    const admission = coordinator.dispatch(submitted, source);
    await vi.waitFor(() => expect(preferences.isMuted).toHaveBeenCalled());
    if (reason === "close") coordinator.clearTab(source.tabId);
    if (reason === "lock") { session = { ...session!, unlocked: false, generation: 2 }; coordinator.clear(); }
    if (reason === "cross-origin") coordinator.navigation(source.tabId, "https://other.example.com");
    if (reason === "expiry") await vi.advanceTimersByTimeAsync(180_000);
    resolveMuted(false);
    expect(await admission).toEqual({ status: "stale" });
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "prompt", prompt: null });
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects a browser document that was already obsolete when the submit arrived", async () => {
    isSubmissionDocument.mockReturnValue(false);
    expect(await coordinator.dispatch(submitted, source)).toEqual({ status: "stale" });
    expect(preferences.isMuted).not.toHaveBeenCalled();
  });
  it.each([{ hasPasswordForm: true, hasError: false }, { hasPasswordForm: false, hasError: true }])(
    "does not treat a login retry/error navigation as success", async (state) => {
      await coordinator.dispatch(submitted, source);
      const nextSource = { ...source, browserDocumentId: "next-browser-document", documentId: "next-isolated-document" };
      const result = await coordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL,
        documentId: nextSource.documentId, type: "resume", hasSuccess: false, ...state }, nextSource);
      expect(result).toEqual({ status: "dismissed" });
      expect(save).not.toHaveBeenCalled();
    },
  );
  it("stores opt-in only after a successful write, bound to the new revision", async () => {
    const view = await ready();
    await coordinator.dispatch(command({ type: "save", promptId: view.id, targetId: view.defaultTargetId!, autoUpdate: true }), source);
    expect(preferences.setAutomatic).toHaveBeenCalledWith("api:user", expect.objectContaining({
      entryId: "alice-entry", revision: "5", origin: "https://accounts.example.com",
    }), true);
  });
  it("uses existing opt-in only for a unique exact account and confirmed password change", async () => {
    preferences.isAutomatic.mockResolvedValue(true);
    await coordinator.dispatch(submitted, source);
    expect(await coordinator.dispatch(confirmed, source)).toEqual({ status: "saved", action: "updated" });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it.each(["ambiguous", "old-password-mismatch", "different-account", "login", "registration", "uncertain"])(
    "requires explicit confirmation despite opt-in: %s", async (scenario) => {
      preferences.isAutomatic.mockResolvedValue(true);
      if (scenario === "ambiguous") choices = { ...choices, targets: [createTarget, updateTarget, updateTarget] };
      if (scenario === "old-password-mismatch") choices = { ...choices, targets: [createTarget, { ...updateTarget, previousPasswordMatches: false }] };
      if (scenario === "different-account") choices = { ...choices, targets: [createTarget, { ...updateTarget, exactAccount: false }] };
      const input = scenario === "login" || scenario === "registration"
        ? command({ type: "submitted", submissionId: "submission-123456789",
          credential: { kind: scenario, username: "alice", password: "new", previousPassword: null } }) : submitted;
      await coordinator.dispatch(input, source);
      const outcome = scenario === "uncertain"
        ? command({ type: "outcome", submissionId: "submission-123456789", outcome: "form-dismissed" }) : confirmed;
      expect((await coordinator.dispatch(outcome, source)).status).toBe("prompt");
      expect(save).not.toHaveBeenCalled();
    },
  );
  it("does not remember opt-in when the mutation fails", async () => {
    save.mockRejectedValue(new Error("sensitive transport detail must not be returned"));
    const view = await ready();
    const result = await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: true }), source);
    expect(prompt(result).error).toBe("save-failed");
    expect(preferences.setAutomatic).not.toHaveBeenCalled();
  });
  it("fences an already prepared write after lock or document invalidation", async () => {
    const view = await ready();
    save.mockImplementation(async (_credential, _url, _target, authorize: () => Promise<boolean>) => {
      session = { ...session!, generation: 2 };
      expect(await authorize()).toBe(false);
      throw new Error("stale");
    });
    expect(await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source)).toEqual({ status: "stale" });
  });
  it("turns a failed automatic write into a manual prompt, without retrying on refresh", async () => {
    preferences.isAutomatic.mockResolvedValue(true);
    save.mockRejectedValueOnce(new Error("connection lost"));
    const view = await ready();
    expect(view.error).toBe("save-failed");
    expect(save).toHaveBeenCalledTimes(1);
    await coordinator.dispatch(command({ type: "get" }), source);
    expect(save).toHaveBeenCalledTimes(1);
    await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("refreshes the revision after a conflict and requires a new explicit confirmation", async () => {
    const view = await ready();
    save.mockRejectedValueOnce(new Error("revision conflict"));
    choices = { ...choices, targets: [createTarget, { ...updateTarget, revision: "6" }] };
    const refreshed = prompt(await coordinator.dispatch(command({ type: "save", promptId: view.id,
      targetId: view.defaultTargetId!, autoUpdate: false }), source));
    expect(refreshed.error).toBe("save-failed");
    expect(refreshed.defaultTargetId).not.toBe(view.defaultTargetId);
    expect(save).toHaveBeenCalledTimes(1);
    await coordinator.dispatch(command({ type: "save", promptId: refreshed.id,
      targetId: refreshed.defaultTargetId!, autoUpdate: false }), source);
    expect(save.mock.calls[1]![2]).toMatchObject({ revision: "6" });
  });
});
