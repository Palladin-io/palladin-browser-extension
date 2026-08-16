import { describe, expect, it, vi } from "vitest";

import { CAPTURE_DETECTED_CHANNEL } from "@shared/messaging/capture";
import type { GeneratedPasswordSaveResult } from "../vault/protocol2/service";

import { CaptureCoordinator, type CaptureTab } from "./coordinator";

const CANDIDATE_ID = "candidate_0123456789abcdef";
const PROMPT_ID = "prompt_0123456789abcdef";
const DOCUMENT_ID = "document_0123456789abcdef";
const BROWSER_DOCUMENT_ID = "browser-document-1";
const TAB: CaptureTab = {
  id: 7,
  url: "https://accounts.example.com/register",
  documentId: DOCUMENT_ID,
  browserDocumentId: BROWSER_DOCUMENT_ID,
};

function harness() {
  let active: CaptureTab | null = TAB;
  let now = 1000;
  const sendFill = vi.fn(async () => ({ ok: true }) as const);
  const savePassword = vi.fn(async (): Promise<GeneratedPasswordSaveResult> => ({ status: "created" }));
  const coordinator = new CaptureCoordinator({
    getActiveTab: async () => active,
    sendFill,
    savePassword,
    now: () => now,
    createId: () => PROMPT_ID,
  });
  return {
    coordinator,
    sendFill,
    savePassword,
    setActive(tab: CaptureTab | null) { active = tab; },
    advance(ms: number) { now += ms; },
  };
}

function observe(coordinator: CaptureCoordinator): boolean {
  return coordinator.observe(
    {
      channel: CAPTURE_DETECTED_CHANNEL,
      documentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      kind: "registration",
    },
    { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID },
  );
}

describe("CaptureCoordinator", () => {
  it("exposes only safe prompt metadata for the still-bound active tab", async () => {
    const { coordinator } = harness();
    expect(observe(coordinator)).toBe(true);

    const result = await coordinator.dispatch({ type: "capture/prompt/get" });

    expect(result).toEqual({
      ok: true,
      kind: "prompt",
      prompt: {
        id: PROMPT_ID,
        kind: "registration",
        site: "example.com",
      },
    });
    expect(JSON.stringify(result)).not.toContain("candidate_");
  });

  it("revalidates the exact origin before relaying a generated value", async () => {
    const { coordinator, sendFill } = harness();
    observe(coordinator);

    const result = await coordinator.dispatch({
      type: "capture/prompt/fill-generated",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    });

    expect(result).toEqual({
      ok: true,
      kind: "fill",
      fill: { status: "filled", saveAvailable: true },
    });
    expect(sendFill).toHaveBeenCalledWith(7, BROWSER_DOCUMENT_ID, {
      channel: "palladin.capture/fill",
      expectedDocumentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID,
      expectedOrigin: "https://accounts.example.com",
      value: "generated-strong-password",
    });
  });

  it("saves only after a successful fill and revalidates the active origin again", async () => {
    const { coordinator, savePassword } = harness();
    observe(coordinator);

    expect(await coordinator.dispatch({
      type: "capture/prompt/save",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    })).toEqual({
      ok: true,
      kind: "save",
      save: { status: "blocked", reason: "not-filled" },
    });
    expect(savePassword).not.toHaveBeenCalled();

    await coordinator.dispatch({
      type: "capture/prompt/fill-generated",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    });
    expect(await coordinator.dispatch({
      type: "capture/prompt/save",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    })).toEqual({
      ok: true,
      kind: "save",
      save: { status: "saved", action: "created" },
    });
    expect(savePassword).toHaveBeenCalledWith({
      kind: "registration",
      site: "example.com",
      url: TAB.url,
      password: "generated-strong-password",
    });
  });

  it("surfaces active-grant refresh as an explicit, value-free blocked save", async () => {
    const { coordinator, savePassword } = harness();
    savePassword.mockResolvedValueOnce({ status: "blocked", reason: "grant-refresh-required" });
    observe(coordinator);
    await coordinator.dispatch({
      type: "capture/prompt/fill-generated",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    });

    const result = await coordinator.dispatch({
      type: "capture/prompt/save",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    });

    expect(result).toEqual({
      ok: true,
      kind: "save",
      save: { status: "blocked", reason: "grant-refresh-required" },
    });
    expect(JSON.stringify(result)).not.toContain("generated-strong-password");
  });

  it("drops a prompt after navigation and never sends the secret", async () => {
    const { coordinator, sendFill, setActive } = harness();
    observe(coordinator);
    setActive({ ...TAB, url: "https://other.example.com/register" });

    const result = await coordinator.dispatch({
      type: "capture/prompt/fill-generated",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    });

    expect(result).toEqual({
      ok: true,
      kind: "fill",
      fill: { status: "blocked", reason: "origin-changed", saveAvailable: false },
    });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("drops a prompt after same-origin document replacement", async () => {
    const { coordinator, sendFill, setActive } = harness();
    observe(coordinator);
    setActive({
      ...TAB,
      documentId: "document_ffffffffffffffff",
      browserDocumentId: "browser-document-2",
    });

    expect(await coordinator.dispatch({
      type: "capture/prompt/fill-generated",
      promptId: PROMPT_ID,
      value: "generated-strong-password",
    })).toEqual({
      ok: true,
      kind: "fill",
      fill: { status: "blocked", reason: "stale-prompt", saveAvailable: false },
    });
    expect(sendFill).not.toHaveBeenCalled();
  });

  it("expires worker-memory prompts and fails closed after a restart-equivalent gap", async () => {
    const { coordinator, advance } = harness();
    observe(coordinator);
    advance(5 * 60_000 + 1);
    expect(await coordinator.dispatch({ type: "capture/prompt/get" })).toEqual({
      ok: true,
      kind: "prompt",
      prompt: null,
    });
  });

  it("rejects insecure observations and allows explicit dismissal", async () => {
    const { coordinator } = harness();
    expect(coordinator.observe(
      {
        channel: CAPTURE_DETECTED_CHANNEL,
        documentId: DOCUMENT_ID,
        candidateId: CANDIDATE_ID,
        kind: "registration",
      },
      {
        tabId: 7,
        url: "http://accounts.example.com/register",
        browserDocumentId: BROWSER_DOCUMENT_ID,
      },
    )).toBe(false);

    observe(coordinator);
    expect(await coordinator.dispatch({
      type: "capture/prompt/dismiss",
      promptId: PROMPT_ID,
    })).toEqual({ ok: true, kind: "dismissed" });
    expect(await coordinator.dispatch({ type: "capture/prompt/get" })).toEqual({
      ok: true,
      kind: "prompt",
      prompt: null,
    });
  });
});
