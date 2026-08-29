export const INLINE_AUTOFILL_CHANNEL = "palladin.inline-autofill.v1" as const;

export type InlineAutofillCommand =
  | {
      readonly channel: typeof INLINE_AUTOFILL_CHANNEL;
      readonly type: "inline/list";
      readonly documentId: string;
    }
  | {
      readonly channel: typeof INLINE_AUTOFILL_CHANNEL;
      readonly type: "inline/fill";
      readonly documentId: string;
      readonly vaultId: string;
      readonly entryId: string;
      /** Related-host fill always requires an explicit closed-surface click. */
      readonly scope: "exact" | "related";
      /** Isolated-world identity of the exact login pair discovered before decryption. */
      readonly loginTargetId: string;
    }
  | {
      readonly channel: typeof INLINE_AUTOFILL_CHANNEL;
      readonly type: "inline/open-palladin";
      readonly documentId: string;
    };

export interface InlineAutofillSuggestion {
  readonly vaultId: string;
  readonly entryId: string;
  readonly name: string;
  readonly username: string;
  readonly vaultName: string;
  readonly urlDomain: string;
  /** Opaque head freshness marker used only to warn after a completed fill changes. */
  readonly updatedAt: string;
  readonly match: "exact" | "related";
}

export type InlineAutofillResult =
  | {
      readonly ok: true;
      readonly kind: "suggestions";
      readonly status: "ready" | "locked" | "signed-out";
      readonly entries: readonly InlineAutofillSuggestion[];
    }
  | {
      readonly ok: true;
      readonly kind: "fill";
      readonly status: "filled" | "no-form" | "blocked";
    }
  | {
      readonly ok: true;
      readonly kind: "surface";
      readonly status: "opened" | "unavailable";
    }
  | { readonly ok: false; readonly code: "unavailable" };

export function isInlineAutofillCommand(value: unknown): value is InlineAutofillCommand {
  if (!isRecord(value) || value.channel !== INLINE_AUTOFILL_CHANNEL || !validDocumentId(value.documentId)) {
    return false;
  }
  if (value.type === "inline/list") {
    return hasOnlyKeys(value, ["channel", "type", "documentId"]);
  }
  if (value.type === "inline/open-palladin") {
    return hasOnlyKeys(value, ["channel", "type", "documentId"]);
  }
  if (value.type === "inline/fill") {
    return hasOnlyKeys(value, [
      "channel",
      "type",
      "documentId",
      "vaultId",
      "entryId",
      "scope",
      "loginTargetId",
    ])
      && validOpaqueId(value.vaultId)
      && validOpaqueId(value.entryId)
      && validOpaqueId(value.loginTargetId)
      && (value.scope === "exact" || value.scope === "related");
  }
  return false;
}

export function isInlineAutofillResult(value: unknown): value is InlineAutofillResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return hasOnlyKeys(value, ["ok", "code"]) && value.code === "unavailable";
  if (value.kind === "fill") {
    return hasOnlyKeys(value, ["ok", "kind", "status"])
      && (value.status === "filled" || value.status === "no-form" || value.status === "blocked");
  }
  if (value.kind === "surface") {
    return hasOnlyKeys(value, ["ok", "kind", "status"])
      && (value.status === "opened" || value.status === "unavailable");
  }
  if (value.kind !== "suggestions"
    || !hasOnlyKeys(value, ["ok", "kind", "status", "entries"])
    || (value.status !== "ready" && value.status !== "locked" && value.status !== "signed-out")
    || !Array.isArray(value.entries)
    || value.entries.length > 100) return false;
  return value.entries.every(isSuggestion);
}

function isSuggestion(value: unknown): value is InlineAutofillSuggestion {
  return isRecord(value)
    && hasOnlyKeys(value, ["vaultId", "entryId", "name", "username", "vaultName", "urlDomain", "updatedAt", "match"])
    && validOpaqueId(value.vaultId)
    && validOpaqueId(value.entryId)
    && validText(value.name, 256)
    && typeof value.username === "string"
    && value.username.length <= 512
    && validText(value.vaultName, 256)
    && validText(value.urlDomain, 253)
    && validText(value.updatedAt, 64)
    && (value.match === "exact" || value.match === "related");
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
