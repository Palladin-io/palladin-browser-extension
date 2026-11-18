import { describe, expect, it, vi } from "vitest";

import { CAPTURE_DETECTED_CHANNEL, GENERATE_PASSWORD_CHANNEL } from "@shared/messaging/capture";
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
  it('rejects a repeated operation but permits a fresh explicit generation without saving a Vault entry', async () => {
    const { coordinator, sendFill, savePassword } = harness();
    observe(coordinator);
    const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID, operationId: 'operation_0123456789abcdef' };
    const source = { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID };
    expect((await coordinator.generate(command, source)).status).toBe('filled');
    expect(sendFill).toHaveBeenCalledWith(TAB.id, BROWSER_DOCUMENT_ID, expect.objectContaining({
      operationId: command.operationId, value: expect.stringMatching(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{20}$/),
    }));
    expect(savePassword).not.toHaveBeenCalled();
    expect((await coordinator.generate(command, source)).status).toBe('blocked');
    expect(sendFill).toHaveBeenCalledTimes(1);
    expect((await coordinator.generate({ ...command, operationId: 'another_operation_0123456789' }, source)).status).toBe('filled');
    expect(sendFill).toHaveBeenCalledTimes(2);
    expect(savePassword).not.toHaveBeenCalled();
  });

  it('fills using the explicitly selected generator settings', async () => {
    const { coordinator, sendFill } = harness();
    observe(coordinator);
    const source = { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID };
    const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID, operationId: 'operation_0123456789abcdef' };
    await coordinator.generate({ ...command, options: { mode: 'password', length: 32, digits: false, symbols: false } }, source);
    expect(sendFill).toHaveBeenLastCalledWith(TAB.id, BROWSER_DOCUMENT_ID, expect.objectContaining({ value: expect.stringMatching(/^[A-Za-z]{32}$/) }));
    await coordinator.generate({ ...command, operationId: 'operation_other_0123456789', options: { mode: 'passphrase', words: 5, separator: '.', capitalize: false, includeNumber: false } }, source);
    expect(sendFill).toHaveBeenLastCalledWith(TAB.id, BROWSER_DOCUMENT_ID, expect.objectContaining({ value: expect.stringMatching(/^[a-z]+(?:\.[a-z]+){4}$/) }));
  });

  it('rejects generation for substituted candidate, document, tab, or origin', async () => {
    const { coordinator, sendFill } = harness();
    observe(coordinator);
    const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: DOCUMENT_ID,
      candidateId: CANDIDATE_ID, operationId: 'operation_0123456789abcdef' };
    const source = { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID };
    for (const [request, sender] of [
      [{ ...command, candidateId: 'other_candidate_0123456789' }, source],
      [{ ...command, documentId: 'other_document_0123456789' }, source],
      [command, { ...source, tabId: 8 }],
      [command, { ...source, browserDocumentId: 'other' }],
      [command, { ...source, url: 'https://other.example.com/signup' }],
    ] as const) expect((await coordinator.generate(request, sender)).status).toBe('blocked');
    expect(sendFill).not.toHaveBeenCalled();
  });
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

describe('inline generator preview', () => {
  const source = { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID };
  const preview = { channel: 'palladin.capture/generator-preview.v1' as const, type: 'preview' as const,
    documentId: DOCUMENT_ID, candidateId: CANDIDATE_ID, options: { mode: 'password' as const, length: 20, digits: true, symbols: true } };
  it('only fills the displayed preview once after explicit use, without a Vault write', async () => {
    const h = harness(); observe(h.coordinator);
    const shown = await h.coordinator.preview(preview, source);
    expect(shown.status).toBe('preview');
    expect(h.sendFill).not.toHaveBeenCalled();
    if (shown.status !== 'preview') throw Error('Missing preview');
    const use = { ...preview, type: 'use' as const, previewId: shown.previewId, operationId: 'operation_preview_123456' };
    expect((await h.coordinator.preview(use, source)).status).toBe('filled');
    expect(h.sendFill).toHaveBeenCalledWith(TAB.id, BROWSER_DOCUMENT_ID, expect.objectContaining({ value: shown.value, operationId: use.operationId }));
    expect((await h.coordinator.preview(use, source)).status).toBe('blocked');
    expect(h.sendFill).toHaveBeenCalledTimes(1); expect(h.savePassword).not.toHaveBeenCalled();
    h.coordinator.clear();
  });
  it.each(['regenerate', 'dismiss', 'lock', 'navigation', 'same-document-navigation', 'expiry'] as const)('revokes the old preview on %s', async cause => {
    const h = harness(); observe(h.coordinator);
    const shown = await h.coordinator.preview(preview, source);
    if (shown.status !== 'preview') throw Error('Missing preview');
    if (cause === 'regenerate') await h.coordinator.preview(preview, source);
    if (cause === 'dismiss') await h.coordinator.preview({ ...preview, type: 'dismiss', previewId: shown.previewId }, source);
    if (cause === 'lock') h.coordinator.clear();
    if (cause === 'navigation') h.coordinator.clearDocument(TAB.id, BROWSER_DOCUMENT_ID);
    if (cause === 'same-document-navigation') h.setActive({ ...TAB, url: 'https://accounts.example.com/next' });
    if (cause === 'expiry') h.advance(60_001);
    expect((await h.coordinator.preview({ ...preview, type: 'use', previewId: shown.previewId, operationId: 'operation_preview_123456' }, source)).status).toBe('blocked');
    expect(h.sendFill).not.toHaveBeenCalled(); h.coordinator.clear();
  });
  it('does not release a preview to a changed active document or a substituted origin', async () => {
    const h = harness(); observe(h.coordinator);
    h.setActive({ ...TAB, browserDocumentId: 'replaced-document' });
    expect((await h.coordinator.preview(preview, source)).status).toBe('blocked');
    h.setActive(TAB); observe(h.coordinator);
    expect((await h.coordinator.preview(preview, { ...source, url: 'https://other.example.test' })).status).toBe('blocked');
    h.coordinator.clear();
  });
});

it('does not release an in-flight preview after lock or replacement by a newer request', async () => {
  const waits: ((tab: CaptureTab | null) => void)[] = [];
  const coordinator = new CaptureCoordinator({ getActiveTab: () => new Promise(resolve => waits.push(resolve)),
    sendFill: vi.fn(), savePassword: vi.fn() });
  observe(coordinator);
  const source = { tabId: TAB.id, url: TAB.url, browserDocumentId: BROWSER_DOCUMENT_ID };
  const request = { channel: 'palladin.capture/generator-preview.v1' as const, type: 'preview' as const,
    documentId: DOCUMENT_ID, candidateId: CANDIDATE_ID, options: { mode: 'password' as const, length: 20, digits: true, symbols: true } };
  const locked = coordinator.preview(request, source); coordinator.clear(); waits.shift()!(TAB);
  expect((await locked).status).toBe('blocked');
  observe(coordinator);
  const old = coordinator.preview(request, source), latest = coordinator.preview(request, source);
  waits.pop()!(TAB); expect((await latest).status).toBe('preview');
  waits.pop()!(TAB); expect((await old).status).toBe('blocked');
  coordinator.clear();
});

it('fills the exact legacy Firefox preview once and rejects its replacement Port even with the same document marker', async () => {
  const h = harness();
  const tab = { id: TAB.id, url: TAB.url, documentId: DOCUMENT_ID, legacyRouteId: 'original-route' };
  const source = { tabId: TAB.id, url: TAB.url, legacyRouteId: 'original-route' };
  h.setActive(tab);
  h.coordinator.observe({ channel: CAPTURE_DETECTED_CHANNEL, documentId: DOCUMENT_ID, candidateId: CANDIDATE_ID, kind: 'registration' }, source);
  const command = { channel: 'palladin.capture/generator-preview.v1' as const, type: 'preview' as const,
    documentId: DOCUMENT_ID, candidateId: CANDIDATE_ID, options: { mode: 'password' as const, length: 20, digits: true, symbols: true } };
  const preview = await h.coordinator.preview(command, source);
  if (preview.status !== 'preview') throw Error('Expected preview');
  const use = { ...command, type: 'use' as const, previewId: preview.previewId, operationId: 'operation_legacy_123456' };
  expect((await h.coordinator.preview(use, source)).status).toBe('filled');
  expect(h.sendFill).toHaveBeenCalledWith(TAB.id, 'legacy:original-route', expect.objectContaining({ value: preview.value }));
  h.setActive({ ...tab, legacyRouteId: 'replacement-route' });
  expect((await h.coordinator.preview(command, source)).status).toBe('blocked');
  expect(h.sendFill).toHaveBeenCalledTimes(1);
  h.coordinator.clear();
});
