/**
 * Worker-owned coordinator for new-password suggestions.
 *
 * Pending prompts contain only structural metadata and live in service-worker
 * memory. Generated values are accepted only from the extension popup, relayed
 * once to a still-bound top-frame candidate, and never stored by this class.
 */

import {
  CAPTURE_FILL_CHANNEL,
  type CaptureDetectedMessage,
  type CaptureFillOutcome,
  type CaptureFillRequestMessage,
  type CaptureGeneratedFillResult,
  type CapturePopupCommand,
  type CapturePopupResult,
  type CapturePromptView,
  type CaptureSaveResult,
} from "@shared/messaging/capture";
import type {
  GeneratedPasswordSaveResult,
  SaveGeneratedPasswordInput,
} from "../vault/protocol2/service";
import { registrableDomain } from "@shared/security/domain";

const PROMPT_TTL_MS = 5 * 60_000;

export interface CaptureSource {
  readonly tabId: number;
  readonly url: string;
  readonly browserDocumentId: string;
}

export interface CaptureTab {
  readonly id: number;
  readonly url: string;
  readonly documentId: string;
  readonly browserDocumentId: string;
}

export interface CaptureCoordinatorDeps {
  getActiveTab(): Promise<CaptureTab | null>;
  sendFill(
    tabId: number,
    browserDocumentId: string,
    message: CaptureFillRequestMessage,
  ): Promise<CaptureFillOutcome>;
  savePassword(input: SaveGeneratedPasswordInput): Promise<GeneratedPasswordSaveResult>;
  now?: () => number;
  createId?: () => string;
}

interface PendingCapture {
  readonly id: string;
  readonly candidateId: string;
  readonly tabId: number;
  readonly documentId: string;
  readonly browserDocumentId: string;
  readonly origin: string;
  readonly site: string;
  readonly kind: CaptureDetectedMessage["kind"];
  readonly observedAt: number;
  readonly filled: boolean;
}

function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function defaultId(): string {
  return crypto.randomUUID();
}

export class CaptureCoordinator {
  private readonly pendingByTab = new Map<number, PendingCapture>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: CaptureCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? defaultId;
  }

  observe(message: CaptureDetectedMessage, source: CaptureSource): boolean {
    const origin = httpsOrigin(source.url);
    const site = registrableDomain(source.url);
    if (origin === null || site === null || !Number.isSafeInteger(source.tabId)) return false;

    const existing = this.pendingByTab.get(source.tabId);
    const observedAt = this.now();
    if (
      existing !== undefined &&
      existing.candidateId === message.candidateId &&
      existing.documentId === message.documentId &&
      existing.browserDocumentId === source.browserDocumentId &&
      existing.origin === origin &&
      existing.kind === message.kind
    ) {
      this.pendingByTab.set(source.tabId, { ...existing, observedAt });
      return true;
    }

    this.pendingByTab.set(source.tabId, {
      id: this.createId(),
      candidateId: message.candidateId,
      tabId: source.tabId,
      documentId: message.documentId,
      browserDocumentId: source.browserDocumentId,
      origin,
      site,
      kind: message.kind,
      observedAt,
      filled: false,
    });
    return true;
  }

  async dispatch(command: CapturePopupCommand): Promise<CapturePopupResult> {
    try {
      switch (command.type) {
        case "capture/prompt/get":
          return { ok: true, kind: "prompt", prompt: await this.currentPrompt() };
        case "capture/prompt/dismiss":
          return await this.dismiss(command.promptId);
        case "capture/prompt/fill-generated":
          return {
            ok: true,
            kind: "fill",
            fill: await this.fillGenerated(command.promptId, command.value),
          };
        case "capture/prompt/save":
          return {
            ok: true,
            kind: "save",
            save: await this.save(command.promptId, command.value),
          };
        default: {
          const _exhaustive: never = command;
          return _exhaustive;
        }
      }
    } catch {
      // Never surface a raw browser error: it may include page-controlled data.
      return { ok: false, code: "unavailable", message: "Capture action failed" };
    }
  }

  private async currentPrompt(): Promise<CapturePromptView | null> {
    const bound = await this.boundPrompt();
    return bound === null ? null : this.toView(bound);
  }

  private async dismiss(promptId: string): Promise<CapturePopupResult> {
    const bound = await this.boundPrompt();
    if (bound === null || bound.id !== promptId) {
      return { ok: true, kind: "dismissed" };
    }
    this.pendingByTab.delete(bound.tabId);
    return { ok: true, kind: "dismissed" };
  }

  private async fillGenerated(
    promptId: string,
    value: string,
  ): Promise<CaptureGeneratedFillResult> {
    const tab = await this.deps.getActiveTab();
    if (tab === null) return this.blocked("stale-prompt");
    const prompt = this.livePrompt(tab.id);
    if (prompt === null || prompt.id !== promptId) return this.blocked("stale-prompt");
    if (tab.documentId !== prompt.documentId
      || tab.browserDocumentId !== prompt.browserDocumentId) {
      this.pendingByTab.delete(prompt.tabId);
      return this.blocked("stale-prompt");
    }

    const activeOrigin = httpsOrigin(tab.url);
    if (activeOrigin === null) {
      this.pendingByTab.delete(prompt.tabId);
      return this.blocked("insecure-page");
    }
    if (activeOrigin !== prompt.origin) {
      this.pendingByTab.delete(prompt.tabId);
      return this.blocked("origin-changed");
    }

    const outcome = await this.deps.sendFill(prompt.tabId, prompt.browserDocumentId, {
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: prompt.documentId,
      candidateId: prompt.candidateId,
      expectedOrigin: prompt.origin,
      value,
    });
    if (outcome.ok) {
      this.pendingByTab.set(prompt.tabId, { ...prompt, filled: true, observedAt: this.now() });
      return { status: "filled", saveAvailable: true };
    }
    if (outcome.reason === "origin-changed") {
      this.pendingByTab.delete(prompt.tabId);
      return this.blocked("origin-changed");
    }
    return { status: "no-form", saveAvailable: false };
  }

  private async save(promptId: string, value: string): Promise<CaptureSaveResult> {
    const tab = await this.deps.getActiveTab();
    if (tab === null) return { status: "blocked", reason: "stale-prompt" };
    const prompt = this.livePrompt(tab.id);
    if (prompt === null || prompt.id !== promptId) {
      return { status: "blocked", reason: "stale-prompt" };
    }
    if (tab.documentId !== prompt.documentId
      || tab.browserDocumentId !== prompt.browserDocumentId) {
      this.pendingByTab.delete(prompt.tabId);
      return { status: "blocked", reason: "stale-prompt" };
    }
    if (!prompt.filled) return { status: "blocked", reason: "not-filled" };
    const activeOrigin = httpsOrigin(tab.url);
    if (activeOrigin === null) {
      this.pendingByTab.delete(prompt.tabId);
      return { status: "blocked", reason: "insecure-page" };
    }
    if (activeOrigin !== prompt.origin) {
      this.pendingByTab.delete(prompt.tabId);
      return { status: "blocked", reason: "origin-changed" };
    }
    const result = await this.deps.savePassword({
      kind: prompt.kind,
      site: prompt.site,
      url: tab.url,
      password: value,
    });
    if (result.status === "blocked") return result;
    this.pendingByTab.delete(prompt.tabId);
    return { status: "saved", action: result.status };
  }

  private async boundPrompt(): Promise<PendingCapture | null> {
    const tab = await this.deps.getActiveTab();
    if (tab === null) return null;
    const prompt = this.livePrompt(tab.id);
    if (prompt === null) return null;
    if (tab.documentId !== prompt.documentId
      || tab.browserDocumentId !== prompt.browserDocumentId) {
      this.pendingByTab.delete(tab.id);
      return null;
    }
    const origin = httpsOrigin(tab.url);
    if (origin === null || origin !== prompt.origin) {
      this.pendingByTab.delete(tab.id);
      return null;
    }
    return prompt;
  }

  private livePrompt(tabId: number): PendingCapture | null {
    const prompt = this.pendingByTab.get(tabId);
    if (prompt === undefined) return null;
    if (this.now() - prompt.observedAt > PROMPT_TTL_MS) {
      this.pendingByTab.delete(tabId);
      return null;
    }
    return prompt;
  }

  private toView(prompt: PendingCapture): CapturePromptView {
    return {
      id: prompt.id,
      kind: prompt.kind,
      site: prompt.site,
    };
  }

  private blocked(
    reason: Extract<CaptureGeneratedFillResult, { status: "blocked" }>["reason"],
  ): CaptureGeneratedFillResult {
    return { status: "blocked", reason, saveAvailable: false };
  }
}
