import { describe, expect, it } from "vitest";

import {
  CAPTURE_DETECTED_CHANNEL,
  CAPTURE_FILL_CHANNEL,
  isCaptureDetectedMessage,
  isCaptureFillOutcome,
  isCaptureFillRequestMessage,
  isCapturePopupCommand,
} from "./capture";

const ID = "candidate_0123456789abcdef";
const DOCUMENT_ID = "document_0123456789abcdef";

describe("capture message guards", () => {
  it("accepts a shape-only new-password observation", () => {
    expect(isCaptureDetectedMessage({
      channel: CAPTURE_DETECTED_CHANNEL,
      documentId: DOCUMENT_ID,
      candidateId: ID,
      kind: "registration",
    })).toBe(true);
  });

  it("rejects extra page values so detection cannot smuggle a secret", () => {
    expect(isCaptureDetectedMessage({
      channel: CAPTURE_DETECTED_CHANNEL,
      documentId: DOCUMENT_ID,
      candidateId: ID,
      kind: "registration",
      password: "must-not-cross",
    })).toBe(false);
  });

  it("accepts only bounded worker-to-isolated generated fills", () => {
    expect(isCaptureFillRequestMessage({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: DOCUMENT_ID,
      candidateId: ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-password",
    })).toBe(true);
    expect(isCaptureFillRequestMessage({
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: DOCUMENT_ID,
      candidateId: ID,
      expectedOrigin: "https://accounts.example.com",
      value: "short",
    })).toBe(false);
  });

  it("keeps popup fill commands explicit and rejects unknown fields", () => {
    expect(isCapturePopupCommand({
      type: "capture/prompt/fill-generated",
      promptId: ID,
      value: "generated-password",
    })).toBe(true);
    expect(isCapturePopupCommand({
      type: "capture/prompt/fill-generated",
      promptId: ID,
      value: "generated-password",
      save: true,
    })).toBe(false);
    expect(isCapturePopupCommand({
      type: "capture/prompt/save",
      promptId: ID,
      value: "generated-password",
    })).toBe(true);
  });

  it("validates value-free fill outcomes", () => {
    expect(isCaptureFillOutcome({ ok: true })).toBe(true);
    expect(isCaptureFillOutcome({ ok: false, reason: "stale-candidate" })).toBe(true);
    expect(isCaptureFillOutcome({ ok: false, reason: "other" })).toBe(false);
  });
});

it('bounds preview options and accepts only ID-bound use without a supplied password', async () => {
  const { isGeneratorPreviewCommand } = await import('./capture');
  const base = { channel: 'palladin.capture/generator-preview.v1', documentId: DOCUMENT_ID, candidateId: ID };
  const options = { mode: 'password', length: 20, digits: true, symbols: true };
  expect(isGeneratorPreviewCommand({ ...base, type: 'preview', options })).toBe(true);
  expect(isGeneratorPreviewCommand({ ...base, type: 'preview', options: { ...options, length: 8 } })).toBe(false);
  expect(isGeneratorPreviewCommand({ ...base, type: 'use', previewId: ID, operationId: ID })).toBe(true);
  expect(isGeneratorPreviewCommand({ ...base, type: 'use', previewId: ID, operationId: ID, value: 'site-substitution' })).toBe(false);
});
