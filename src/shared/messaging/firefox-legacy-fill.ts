import { isFillOutcome, isFillRequestMessage, type FillOutcome, type FillRequestMessage } from "./fill";

/** Private worker ↔ isolated-document Port, never the main-world bridge. */
export const FIREFOX_LEGACY_FILL_PORT = "palladin.firefox.legacy-fill.v1";
export type LegacyFillToWorker =
  | { readonly type: "hello"; readonly documentId: string }
  | { readonly type: "result"; readonly requestId: string; readonly outcome: FillOutcome };
export type LegacyFillToDocument =
  | { readonly type: "ready" }
  | { readonly type: "unsupported" }
  | { readonly type: "fill"; readonly requestId: string; readonly issuedAt: number; readonly request: FillRequestMessage };
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}
export function isLegacyDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
export function isLegacyFillToWorker(value: unknown): value is LegacyFillToWorker {
  return (keys(value, ["type", "documentId"]) && value.type === "hello" && isLegacyDocumentId(value.documentId))
    || (keys(value, ["type", "requestId", "outcome"]) && value.type === "result"
      && typeof value.requestId === "string" && value.requestId.length === 36 && isFillOutcome(value.outcome)
      && keys(value.outcome, value.outcome.ok ? ["ok"] : ["ok", "reason"]));
}
export function isLegacyFillToDocument(value: unknown): value is LegacyFillToDocument {
  return (keys(value, ["type"]) && (value.type === "ready" || value.type === "unsupported"))
    || (keys(value, ["type", "requestId", "issuedAt", "request"]) && value.type === "fill"
      && typeof value.issuedAt === "number" && Number.isSafeInteger(value.issuedAt) && value.issuedAt >= 0
      && typeof value.requestId === "string" && value.requestId.length === 36 && isFillRequestMessage(value.request));
}
