import { generateInlinePassphrase } from '@shared/crypto/inline-passphrase';
import { captureDocumentKey } from './document-identity';
/**
 * Worker-owned coordinator for new-password suggestions.
 *
 * Prompts and one short-lived generated preview per tab live only in bounded
 * worker memory. Preview values leave the worker only for their bound closed
 * surface; explicit Use consumes the preview before the existing fill gates.
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
import { generatePassword, generatePassphrase } from '@palladin/crypto';
import { GENERATED_PASSWORD_LENGTH, type GeneratePasswordCommand, type GeneratorPreviewCommand, type GeneratorPreviewResult } from '@shared/messaging/capture';

const PROMPT_TTL_MS = 5 * 60_000;

export interface CaptureSource {
  readonly tabId: number;
  readonly url: string;
  readonly browserDocumentId?: string;
  readonly legacyRouteId?: string;
}

export interface CaptureTab {
  readonly id: number;
  readonly url: string;
  readonly documentId: string;
  readonly browserDocumentId?: string;
  readonly legacyRouteId?: string;
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
  readonly documentKey: string;
  readonly origin: string;
  readonly site: string;
  readonly kind: CaptureDetectedMessage["kind"];
  readonly observedAt: number;
  readonly filled: boolean;
  readonly generationOperationId?: string;
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
  private readonly previews = new Map<number, { id: string; value: string; expiresAt: number; url: string; promptId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly previewRequests = new Map<number, symbol>();

  private dropPreview(tabId: number): void {
    const preview = this.previews.get(tabId);
    if (preview) clearTimeout(preview.timer);
    this.previews.delete(tabId);
    this.previewRequests.delete(tabId);
  }

  clear(): void {
    for (const tabId of this.previews.keys()) this.dropPreview(tabId);
    this.previewRequests.clear(); this.pendingByTab.clear();
  }

  clearTab(tabId: number): void { this.dropPreview(tabId); this.pendingByTab.delete(tabId); }

  clearDocument(tabId: number, browserDocumentId: string): void {
    if (this.pendingByTab.get(tabId)?.documentKey === browserDocumentId) this.clearTab(tabId);
  }

  async preview(command: GeneratorPreviewCommand, source: CaptureSource): Promise<GeneratorPreviewResult> {
    const prompt = this.livePrompt(source.tabId);
    if (!prompt || prompt.candidateId !== command.candidateId || prompt.documentId !== command.documentId
      || prompt.documentKey !== captureDocumentKey(source) || prompt.origin !== httpsOrigin(source.url)) return this.blocked('stale-prompt');
    if (command.type === 'dismiss') {
      const current = this.previews.get(source.tabId);
      if (!command.previewId || current?.id === command.previewId) this.dropPreview(source.tabId);
      return { status: 'dismissed' };
    }
    const request = Symbol();
    while (this.previewRequests.size >= 20 && !this.previewRequests.has(source.tabId)) this.dropPreview(this.previewRequests.keys().next().value!);
    this.previewRequests.set(source.tabId, request);
    const active = await this.deps.getActiveTab();
    const latest = this.previewRequests.get(source.tabId) === request;
    if (latest) this.previewRequests.delete(source.tabId);
    if (!latest || this.pendingByTab.get(source.tabId) !== prompt
      || active?.id !== source.tabId || active.documentId !== prompt.documentId || captureDocumentKey(active) !== prompt.documentKey
      || active.url !== source.url || httpsOrigin(active.url) !== prompt.origin) return this.blocked('stale-prompt');
    if (command.type === 'use') {
      const current = this.previews.get(source.tabId);
      if (!current || current.id !== command.previewId || current.promptId !== prompt.id || current.url !== source.url || this.now() >= current.expiresAt) {
        this.dropPreview(source.tabId); return this.blocked('stale-prompt');
      }
      this.dropPreview(source.tabId);
      return this.fillGenerated(prompt.id, current.value, command.operationId);
    }
    this.dropPreview(source.tabId);
    while (this.previews.size >= 20) this.dropPreview(this.previews.keys().next().value!);
    const options = command.options;
    const value = options.mode === 'password' ? generatePassword(options) : generateInlinePassphrase(options);
    const id = crypto.randomUUID(), expiresAt = this.now() + 60_000;
    const timer = setTimeout(() => { if (this.previews.get(source.tabId)?.id === id) this.dropPreview(source.tabId); }, 60_000);
    this.previews.set(source.tabId, { id, value, expiresAt, url: source.url, promptId: prompt.id, timer });
    return { status: 'preview', previewId: id, value, expiresAt };
  }

  private readonly pendingByTab = new Map<number, PendingCapture>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: CaptureCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? defaultId;
  }

  async generate(command: GeneratePasswordCommand, source: CaptureSource): Promise<CaptureGeneratedFillResult> {
    const prompt = this.livePrompt(source.tabId);
    if (!prompt || prompt.generationOperationId === command.operationId || prompt.candidateId !== command.candidateId
      || prompt.documentId !== command.documentId || prompt.documentKey !== captureDocumentKey(source)
      || prompt.origin !== httpsOrigin(source.url)) return this.blocked('stale-prompt');
    this.pendingByTab.set(source.tabId, { ...prompt, generationOperationId: command.operationId });
    const options = command.options ?? { mode: 'password', length: GENERATED_PASSWORD_LENGTH, digits: true, symbols: true };
    const value = options.mode === 'passphrase' ? generatePassphrase(options) : generatePassword(options);
    return this.fillGenerated(prompt.id, value, command.operationId);
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
      existing.documentKey === captureDocumentKey(source) &&
      existing.origin === origin &&
      existing.kind === message.kind
    ) {
      this.pendingByTab.set(source.tabId, { ...existing, observedAt });
      return true;
    }

    this.dropPreview(source.tabId);
    this.pendingByTab.set(source.tabId, {
      id: this.createId(),
      candidateId: message.candidateId,
      tabId: source.tabId,
      documentId: message.documentId,
      documentKey: captureDocumentKey(source),
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
    operationId?: string,
  ): Promise<CaptureGeneratedFillResult> {
    const tab = await this.deps.getActiveTab();
    if (tab === null) return this.blocked("stale-prompt");
    const prompt = this.livePrompt(tab.id);
    if (prompt === null || prompt.id !== promptId) return this.blocked("stale-prompt");
    if (tab.documentId !== prompt.documentId
      || captureDocumentKey(tab) !== prompt.documentKey) {
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

    const outcome = await this.deps.sendFill(prompt.tabId, prompt.documentKey, {
      channel: CAPTURE_FILL_CHANNEL,
      expectedDocumentId: prompt.documentId,
      candidateId: prompt.candidateId,
      expectedOrigin: prompt.origin,
      value,
      ...(operationId === undefined ? {} : { operationId }),
    });
    if (this.pendingByTab.get(prompt.tabId) !== prompt) return this.blocked("stale-prompt");
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
      || captureDocumentKey(tab) !== prompt.documentKey) {
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
      || captureDocumentKey(tab) !== prompt.documentKey) {
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
