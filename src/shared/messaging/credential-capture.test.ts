import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_CAPTURE_CHANNEL,
  isCredentialCaptureCommand,
  isCredentialCaptureResult,
} from "./credential-capture";

const base = { channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: "document-123456789" };
const submitted = {
  ...base, type: "submitted", submissionId: "submission-123456789",
  credential: { kind: "login", username: "alice", password: " x ", previousPassword: null },
};

describe("isolated credential capture protocol", () => {
  it('accepts only bounded registration identity alternatives and value-free choices', () => {
    const credential = { kind: 'registration', username: '', password: 'secret', previousPassword: null,
      usernameOptions: { email: 'contact@example.test', nickname: 'handle' } };
    expect(isCredentialCaptureCommand({ ...submitted, credential })).toBe(true);
    for (const patch of [{ kind: 'login' }, { username: 'preselected' }, { usernameOptions: { email: '', nickname: 'handle' } },
      { usernameOptions: { email: 'contact@example.test', nickname: 'x'.repeat(513) } },
      { usernameOptions: { email: 'contact@example.test' } },
      { usernameOptions: { email: ' contact@example.test', nickname: 'handle' } },
      { usernameOptions: null },
      { usernameOptions: { email: 'same', nickname: 'same' } },
      { usernameOptions: { email: 'contact@example.test', nickname: 'handle', password: 'injected' } }]) {
      expect(isCredentialCaptureCommand({ ...submitted, credential: { ...credential, ...patch } })).toBe(false);
    }
    const choose = { ...base, type: 'choose-username', promptId: submitted.submissionId, choice: 'email' };
    expect(isCredentialCaptureCommand(choose)).toBe(true);
    expect(isCredentialCaptureCommand({ ...choose, choice: 'nickname' })).toBe(true);
    expect(isCredentialCaptureCommand({ ...choose, choice: 'other' })).toBe(false);
    expect(isCredentialCaptureCommand({ ...choose, username: 'injected' })).toBe(false);
  });
  it('keeps identity selection responses value-free and forbids write targets before selection', () => {
    const prompt = { id: submitted.submissionId, site: 'example.com', state: 'ready', targets: [],
      defaultTargetId: null, usernameSelection: { selected: null } };
    expect(isCredentialCaptureResult({ status: 'prompt', prompt })).toBe(true);
    for (const patch of [
      { state: 'locked' },
      { usernameSelection: { selected: 'invalid' } },
      { usernameSelection: {} },
      { usernameSelection: { selected: null, email: 'private@example.test' } },
      { usernameOptions: { email: 'private@example.test', nickname: 'private-handle' } },
      { targets: [{ id: submitted.submissionId, action: 'create', label: 'Personal', vaultLabel: 'Personal' }] },
    ]) expect(isCredentialCaptureResult({ status: 'prompt', prompt: { ...prompt, ...patch } })).toBe(false);
    for (const selected of ['email', 'nickname']) {
      expect(isCredentialCaptureResult({ status: 'prompt', prompt: { ...prompt, usernameSelection: { selected } } })).toBe(true);
    }
  });
  it("accepts short passwords without normalizing their value", () => {
    expect(isCredentialCaptureCommand(submitted)).toBe(true);
    expect(isCredentialCaptureCommand({ ...submitted, credential: { ...submitted.credential, password: "x" } })).toBe(true);
  });

  it.each([
    { channel: "page-channel" }, { documentId: "short" }, { submissionId: "" },
    { url: "https://attacker.example" }, { type: "update-entry" }, { credential: null },
    { credential: { ...submitted.credential, password: "" } },
    { credential: { ...submitted.credential, password: "x".repeat(4097) } },
    { credential: { ...submitted.credential, username: "x".repeat(513) } },
    { credential: { ...submitted.credential, previousPassword: "old" } },
    { credential: { ...submitted.credential, grantEnvelopes: [] } },
  ])("rejects invalid/untrusted payload %j", (patch) => {
    expect(isCredentialCaptureCommand({ ...submitted, ...patch })).toBe(false);
  });

  it("requires typed, exact commands for every step", () => {
    const commands = [
      { type: "identifier", submissionId: submitted.submissionId, username: "alice@example.test" },
      { type: "outcome", submissionId: submitted.submissionId, outcome: "success-message" },
      { type: "outcome", submissionId: submitted.submissionId, outcome: "form-dismissed" },
      { type: "outcome", submissionId: submitted.submissionId, outcome: "rejected" },
      { type: "resume", hasPasswordForm: false, hasError: false, hasSuccess: false },
      { type: "get" }, { type: "unlock" },
      { type: "save", promptId: submitted.submissionId, targetId: submitted.submissionId, autoUpdate: false },
      { type: "dismiss", promptId: submitted.submissionId }, { type: "mute", promptId: submitted.submissionId },
    ];
    for (const command of commands) {
      expect(isCredentialCaptureCommand({ ...base, ...command })).toBe(true);
      expect(isCredentialCaptureCommand({ ...base, ...command, password: "injected" })).toBe(false);
    }
    expect(isCredentialCaptureCommand({ ...base, type: "resume", hasPasswordForm: "false", hasError: false })).toBe(false);
    expect(isCredentialCaptureCommand({ ...base, type: "outcome", submissionId: submitted.submissionId, outcome: "maybe" })).toBe(false);
  });

  it("never accepts credentials in a returned view", () => {
    const prompt = { id: submitted.submissionId, site: "example.com", state: "locked", targets: [], defaultTargetId: null };
    expect(isCredentialCaptureResult({ status: "prompt", prompt })).toBe(true);
    expect(isCredentialCaptureResult({ status: "prompt", prompt: { ...prompt, error: "save-failed" } })).toBe(true);
    expect(isCredentialCaptureResult({ status: "prompt", prompt: { ...prompt, error: "raw server response" } })).toBe(false);
    expect(isCredentialCaptureResult({ status: "prompt", prompt: { ...prompt, password: "secret" } })).toBe(false);
    expect(isCredentialCaptureResult({ status: "saved", action: "updated", password: "secret" })).toBe(false);
    expect(isCredentialCaptureResult({ status: "prompt", prompt: { ...prompt, defaultTargetId: submitted.submissionId } })).toBe(false);
  });
  it.each(["", " ", " alice", "x".repeat(513), 123, null])("rejects malformed identifier-only input", (username) => {
    expect(isCredentialCaptureCommand({ ...base, type: "identifier", submissionId: submitted.submissionId, username })).toBe(false);
  });
});
