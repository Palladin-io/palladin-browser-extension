import {
  isInlineAutofillCommand,
  type InlineAutofillCommand,
  type InlineAutofillResult,
} from "@shared/messaging";

import type { SessionStatus } from "../session/types";
import type { ActiveTab, FillResult } from "./commands";
import {
  ENTRY_TYPE_CREDENTIAL,
  entriesForTab,
  relatedEntriesForTab,
  searchEntries,
  type EntryMetadata,
} from "./entry-metadata";

export interface InlineAutofillDeps {
  resolveLegacySource?(documentId: string, sender: chrome.runtime.MessageSender): Promise<ActiveTab | null>;
  getStatus(): Promise<SessionStatus>;
  getMetadata(): Promise<EntryMetadata[]>;
  loadIcon?(icon: string): Promise<string | undefined>;
  fill(
    source: ActiveTab,
    vaultId: string,
    entryId: string,
    scope: "exact" | "related",
    loginTargetId: string,
    intent: "automatic" | "manual",
    purpose?: "totp",
    assertCurrent?: () => void,
  ): Promise<FillResult>;
  readonly recency?: InlineAutofillRecency;
  /** Federated sign-in: explicit provider-account choice for this tab, and Palladin-filled accounts. */
  readonly signIn?: {
    preferred(tabId: number, url: string, candidates: readonly EntryMetadata[]): EntryMetadata | null;
    filled(tabId: number, url: string, entry: EntryMetadata | undefined, intent: "automatic" | "manual"): void;
  };
}

export interface InlineAutofillRecency {
  preferred(url: string): { readonly vaultId: string; readonly entryId: string } | null;
  remember(url: string, vaultId: string, entryId: string): void;
  clear(): void;
  capture?(tabId: number, url: string): () => boolean;
  beginNative?(tabId: number, url: string): (success: boolean) => void;
  pendingNative?(tabId: number, url: string): Promise<boolean> | null;
  nativeChoice?(tabId: number, url: string): { readonly vaultId: string; readonly entryId: string } | null;
  preferredForTab?(tabId: number, url: string): { readonly vaultId: string; readonly entryId: string } | null;
  rememberForTab?(tabId: number, url: string, vaultId: string, entryId: string): void;
}

/**
 * Session-memory preference only. Persisting this would create a cleartext
 * history of sites and Entry IDs outside the encrypted Vault.
 */
export class InMemoryInlineAutofillRecency implements InlineAutofillRecency {
  private sessionVersion = 0;
  private readonly nativeByTab = new Map<number, { host: string; vaultId: string; entryId: string }>();
  private readonly pendingByTab = new Map<number, { host: string | null; promise: Promise<boolean>; finish: (success: boolean) => void }>();
  private readonly tabVersions = new Map<number, number>();
  private readonly tabHosts = new Map<number, string | null>();
  private readonly byTab = new Map<number, { host: string; vaultId: string; entryId: string }>();
  private readonly byHost = new Map<string, { readonly vaultId: string; readonly entryId: string }>();

  preferred(url: string): { readonly vaultId: string; readonly entryId: string } | null {
    const host = exactHttpsHost(url);
    return host === null ? null : this.byHost.get(host) ?? null;
  }

  remember(url: string, vaultId: string, entryId: string): void {
    const host = exactHttpsHost(url);
    if (host !== null) this.byHost.set(host, { vaultId, entryId });
  }

  preferredForTab(tabId: number, url: string): { vaultId: string; entryId: string } | null {
    const selected = this.byTab.get(tabId);
    if (!selected) return null;
    if (selected.host !== exactHttpsHost(url)) { this.byTab.delete(tabId); return null; }
    return selected;
  }

  rememberForTab(tabId: number, url: string, vaultId: string, entryId: string): void {
    const host = exactHttpsHost(url);
    if (host !== null) {
      const native = this.nativeByTab.get(tabId);
      if (native && (native.host !== host || native.vaultId !== vaultId || native.entryId !== entryId)) this.nativeByTab.delete(tabId);
      this.byTab.set(tabId, { host, vaultId, entryId });
    }
  }

  capture(tabId: number, url: string): () => boolean {
    this.navigation(tabId, url);
    const session = this.sessionVersion, version = this.tabVersions.get(tabId) ?? 0;
    return () => session === this.sessionVersion && version === (this.tabVersions.get(tabId) ?? 0);
  }
  beginNative(tabId: number, url: string): (success: boolean) => void {
    this.navigation(tabId, url);
    this.pendingByTab.get(tabId)?.finish(false);
    this.tabVersions.set(tabId, (this.tabVersions.get(tabId) ?? 0) + 1);
    let resolve!: (success: boolean) => void;
    const pending = { host: exactHttpsHost(url), promise: new Promise<boolean>(done => { resolve = done; }),
      finish: (success: boolean) => {
        if (this.pendingByTab.get(tabId) === pending) {
          this.pendingByTab.delete(tabId);
          const selected = this.byTab.get(tabId);
          if (success && selected && selected.host === pending.host) this.nativeByTab.set(tabId, selected);
        }
        resolve(success);
      } };
    this.pendingByTab.set(tabId, pending);
    return pending.finish;
  }
  pendingNative(tabId: number, url: string): Promise<boolean> | null {
    const pending = this.pendingByTab.get(tabId);
    return pending && pending.host === exactHttpsHost(url) ? pending.promise : null;
  }
  nativeChoice(tabId: number, url: string): { vaultId: string; entryId: string } | null {
    const selected = this.nativeByTab.get(tabId);
    return selected?.host === exactHttpsHost(url) ? selected : null;
  }
  clearTab(tabId: number): void {
    this.nativeByTab.delete(tabId);
    this.pendingByTab.get(tabId)?.finish(false);
    this.byTab.delete(tabId); this.tabHosts.delete(tabId);
    this.tabVersions.set(tabId, (this.tabVersions.get(tabId) ?? 0) + 1);
  }
  navigation(tabId: number, url: string): void {
    const host = exactHttpsHost(url);
    if (this.tabHosts.has(tabId) && this.tabHosts.get(tabId) !== host) this.clearTab(tabId);
    this.tabHosts.set(tabId, host);
  }

  clear(): void {
    for (const pending of this.pendingByTab.values()) pending.finish(false);
    this.sessionVersion++; this.tabVersions.clear(); this.tabHosts.clear();
    this.byTab.clear(); this.nativeByTab.clear();
    this.byHost.clear();
  }
}

export async function handleInlineAutofillContentMessage(
  deps: InlineAutofillDeps,
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): Promise<InlineAutofillResult | null> {
  if (!isInlineAutofillCommand(raw)) return null;
  if (raw.type === "inline/open-palladin") return null;
  try {
    const source = inlineAutofillSource(raw, sender, extensionId)
      ?? (sender.documentId == null ? await deps.resolveLegacySource?.(raw.documentId, sender) : null);
    if (!source || (raw.type === "inline/fill" && raw.purpose === "totp" && sender.frameId !== 0)) return { ok: false, code: "unavailable" };
    const pendingNative = deps.recency?.pendingNative?.(source.id, source.url);
    if (pendingNative && (raw.type === "inline/list" || raw.intent === "automatic")) {
      if (!await pendingNative) return { ok: false, code: "unavailable" };
      if (raw.type === "inline/fill") {
        const selected = deps.recency?.preferredForTab?.(source.id, source.url);
        if (!selected || selected.vaultId !== raw.vaultId || selected.entryId !== raw.entryId)
          return { ok: true, kind: "fill", status: "blocked" };
      }
    }
    const operationBeforeStatus = raw.type === "inline/list" || raw.intent === "automatic"
      ? deps.recency?.capture?.(source.id, source.url) : undefined;
    const status = await deps.getStatus();
    if (raw.type === "inline/list") {
      if (status !== "unlocked") {
        return { ok: true, kind: "suggestions", status, entries: [] };
      }
      const metadata = await deps.getMetadata();
      const exact = searchEntries(entriesForTab(metadata, source.url), "")
        .filter((entry) => entry.type === ENTRY_TYPE_CREDENTIAL && entry.urlDomain)
        .map((entry) => ({ entry, match: "exact" as const }));
      const chosen = deps.signIn?.preferred(source.id, source.url, exact.map(({ entry }) => entry)) ?? null;
      const continuation = deps.recency?.nativeChoice?.(source.id, source.url)
        ?? (chosen !== null ? { vaultId: chosen.vaultId, entryId: chosen.id }
          : deps.recency?.preferredForTab?.(source.id, source.url) ?? null);
      const preferred = continuation ?? deps.recency?.preferred(source.url) ?? null;
      if (preferred !== null) {
        exact.sort((left, right) => Number(
          right.entry.vaultId === preferred.vaultId && right.entry.id === preferred.entryId,
        ) - Number(
          left.entry.vaultId === preferred.vaultId && left.entry.id === preferred.entryId,
        ));
      }
      const related = searchEntries(relatedEntriesForTab(metadata, source.url), "")
        .filter((entry) => entry.type === ENTRY_TYPE_CREDENTIAL && entry.urlDomain)
        .map((entry) => ({ entry, match: "related" as const }));
      const matches = [...exact, ...related].slice(0, 20);
      const icons = new Map<string, Promise<string | undefined>>();
      for (const { entry } of matches) {
        if (entry.icon && deps.loadIcon && !icons.has(entry.icon)) {
          icons.set(entry.icon, deps.loadIcon(entry.icon).catch(() => undefined));
        }
      }
      const entries = await Promise.all(matches
        .filter(({ entry }) => entry.username !== undefined)
        .map(async ({ entry, match }) => ({
          vaultId: entry.vaultId,
          entryId: entry.id,
          name: entry.name,
          username: entry.username!,
          vaultName: entry.vaultName,
          urlDomain: entry.urlDomain!,
          updatedAt: entry.updatedAt,
          match,
          ...(entry.icon && await icons.get(entry.icon)
            ? { iconDataUrl: (await icons.get(entry.icon))! } : {}),
        })));
      const currentStatus = await deps.getStatus();
      if (currentStatus !== "unlocked") return { ok: true, kind: "suggestions", status: currentStatus, entries: [] };
      // The status query also yields; never return an account chosen before a
      // newly started native operation has resolved.
      if (deps.recency?.pendingNative?.(source.id, source.url))
        return handleInlineAutofillContentMessage(deps, raw, sender, extensionId);
      if (operationBeforeStatus && !operationBeforeStatus()) return { ok: false, code: "unavailable" };
      return { ok: true, kind: "suggestions", status: "ready", entries, ...(continuation ? { continuation: { vaultId: continuation.vaultId, entryId: continuation.entryId } } : {}) };
    }
    if (status !== "unlocked") return { ok: true, kind: "fill", status: "blocked" };
    if (raw.intent === "automatic" && deps.recency?.pendingNative?.(source.id, source.url))
      return handleInlineAutofillContentMessage(deps, raw, sender, extensionId);
    if (operationBeforeStatus && !operationBeforeStatus()) return { ok: true, kind: "fill", status: "blocked" };
    const nativeChoice = deps.recency?.nativeChoice?.(source.id, source.url);
    if (raw.intent === "automatic" && nativeChoice
      && (nativeChoice.vaultId !== raw.vaultId || nativeChoice.entryId !== raw.entryId))
      return { ok: true, kind: "fill", status: "blocked" };
    const stillCurrent = deps.recency?.capture?.(source.id, source.url);
    const fill = raw.intent === "automatic" && stillCurrent
      ? await deps.fill(source, raw.vaultId, raw.entryId, raw.scope, raw.loginTargetId, raw.intent, raw.purpose,
        () => { if (!stillCurrent()) throw new Error("Fill superseded"); })
      : raw.purpose === "totp"
      ? await deps.fill(source, raw.vaultId, raw.entryId, raw.scope, raw.loginTargetId, raw.intent, "totp")
      : await deps.fill(source, raw.vaultId, raw.entryId, raw.scope, raw.loginTargetId, raw.intent);
    if (fill.status === "filled" && raw.scope === "exact" && (stillCurrent?.() ?? true)) {
      deps.recency?.remember(source.url, raw.vaultId, raw.entryId);
      deps.recency?.rememberForTab?.(source.id, source.url, raw.vaultId, raw.entryId);
      if (deps.signIn && (raw.purpose !== "totp" || raw.intent === "manual")) {
        const filled = (await deps.getMetadata()).find((entry) => entry.vaultId === raw.vaultId && entry.id === raw.entryId);
        deps.signIn.filled(source.id, source.url, filled, raw.intent);
      }
    }
    return {
      ok: true,
      kind: "fill",
      status: fill.status === "filled"
        ? "filled"
        : fill.status === "no-form"
          ? "no-form"
          : fill.reason === "network" ? "unavailable" : "blocked",
    };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export function inlineAutofillSource(
  command: InlineAutofillCommand,
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): ActiveTab | null {
  if (sender.id !== extensionId || typeof sender.frameId !== 'number' || sender.frameId < 0) return null;
  if (typeof sender.tab?.id !== "number" || typeof sender.tab.url !== "string") return null;
  if (typeof sender.url !== "string"
    || !inlineAutofillFramePairAllowed(sender.url, sender.tab.url)) return null;
  if (sender.frameId !== 0 && new URL(sender.url).hostname !== 'idmsa.apple.com') return null;
  if (typeof sender.documentId !== "string" || sender.documentId.length === 0) return null;
  return {
    id: sender.tab.id,
    url: sender.url,
    documentId: command.documentId,
    browserDocumentId: sender.documentId,
  };
}

export function inlineAutofillFramePairAllowed(frameUrl: string, tabUrl: string): boolean {
  if (sameHttpsOrigin(frameUrl, tabUrl)) return true;
  try {
    const frame = new URL(frameUrl);
    const tab = new URL(tabUrl);
    return frame.origin === 'https://idmsa.apple.com'
      && frame.pathname === '/appleauth/auth/authorize/signin'
      && tab.origin === 'https://account.apple.com'
      && tab.pathname === '/sign-in';
  } catch {
    return false;
  }
}

export async function appleInlineFrameStillAuthorized(
  frameUrl: string,
  tabId: number,
  currentTabUrl: (tabId: number) => Promise<string | undefined>,
): Promise<boolean> {
  try {
    if (new URL(frameUrl).origin !== 'https://idmsa.apple.com') return true;
    const topUrl = await currentTabUrl(tabId);
    return typeof topUrl === 'string' && inlineAutofillFramePairAllowed(frameUrl, topUrl);
  } catch {
    return false;
  }
}

function sameHttpsOrigin(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    return first.protocol === "https:" && second.protocol === "https:" && first.origin === second.origin;
  } catch {
    return false;
  }
}

function exactHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      ? parsed.hostname.toLowerCase().replace(/\.$/, "")
      : null;
  } catch {
    return null;
  }
}
