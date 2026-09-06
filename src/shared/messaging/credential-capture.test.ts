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
});
