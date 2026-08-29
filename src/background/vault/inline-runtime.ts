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
  getStatus(): Promise<SessionStatus>;
  getMetadata(): Promise<EntryMetadata[]>;
  fill(
    source: ActiveTab,
    vaultId: string,
    entryId: string,
    scope: "exact" | "related",
    loginTargetId: string,
  ): Promise<FillResult>;
  readonly recency?: InlineAutofillRecency;
}

export interface InlineAutofillRecency {
  preferred(url: string): { readonly vaultId: string; readonly entryId: string } | null;
  remember(url: string, vaultId: string, entryId: string): void;
  clear(): void;
}

/**
 * Session-memory preference only. Persisting this would create a cleartext
 * history of sites and Entry IDs outside the encrypted Vault.
 */
export class InMemoryInlineAutofillRecency implements InlineAutofillRecency {
  private readonly byHost = new Map<string, { readonly vaultId: string; readonly entryId: string }>();

  preferred(url: string): { readonly vaultId: string; readonly entryId: string } | null {
    const host = exactHttpsHost(url);
    return host === null ? null : this.byHost.get(host) ?? null;
  }

  remember(url: string, vaultId: string, entryId: string): void {
    const host = exactHttpsHost(url);
    if (host !== null) this.byHost.set(host, { vaultId, entryId });
  }

  clear(): void {
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
  const source = inlineAutofillSource(raw, sender, extensionId);
  if (source === null) return { ok: false, code: "unavailable" };

  try {
    const status = await deps.getStatus();
    if (raw.type === "inline/list") {
      if (status !== "unlocked") {
        return { ok: true, kind: "suggestions", status, entries: [] };
      }
      const metadata = await deps.getMetadata();
      const exact = searchEntries(entriesForTab(metadata, source.url), "")
        .filter((entry) => entry.type === ENTRY_TYPE_CREDENTIAL && entry.urlDomain)
        .map((entry) => ({ entry, match: "exact" as const }));
      const preferred = deps.recency?.preferred(source.url) ?? null;
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
      const entries = matches
        .filter(({ entry }) => entry.username !== undefined)
        .map(({ entry, match }) => ({
          vaultId: entry.vaultId,
          entryId: entry.id,
          name: entry.name,
          username: entry.username!,
          vaultName: entry.vaultName,
          urlDomain: entry.urlDomain!,
          updatedAt: entry.updatedAt,
          match,
        }));
      return { ok: true, kind: "suggestions", status: "ready", entries };
    }
    if (status !== "unlocked") return { ok: true, kind: "fill", status: "blocked" };
    const fill = await deps.fill(
      source,
      raw.vaultId,
      raw.entryId,
      raw.scope,
      raw.loginTargetId,
    );
    if (fill.status === "filled" && raw.scope === "exact") {
      deps.recency?.remember(source.url, raw.vaultId, raw.entryId);
    }
    return {
      ok: true,
      kind: "fill",
      status: fill.status === "filled" ? "filled" : fill.status === "no-form" ? "no-form" : "blocked",
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
  if (sender.id !== extensionId || sender.frameId !== 0) return null;
  if (typeof sender.tab?.id !== "number" || typeof sender.tab.url !== "string") return null;
  if (typeof sender.url !== "string" || !sameHttpsOrigin(sender.url, sender.tab.url)) return null;
  if (typeof sender.documentId !== "string" || sender.documentId.length === 0) return null;
  return {
    id: sender.tab.id,
    url: sender.url,
    documentId: command.documentId,
    browserDocumentId: sender.documentId,
  };
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
