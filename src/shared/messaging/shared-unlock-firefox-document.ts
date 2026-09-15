export const FIREFOX_DOCUMENT_BINDING = "palladin.shared-unlock.firefox.document.v1";
export const FIREFOX_CURRENT_DOCUMENT = "palladin.shared-unlock.firefox.current-document.v1";

export interface FirefoxDocumentBinding {
  readonly type: typeof FIREFOX_DOCUMENT_BINDING;
  readonly marker: string;
}
export function isFirefoxDocumentMarker(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function isFirefoxDocumentBinding(value: unknown): value is FirefoxDocumentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<FirefoxDocumentBinding>;
  return Object.keys(value).sort().join(",") === "marker,type" && candidate.type === FIREFOX_DOCUMENT_BINDING && isFirefoxDocumentMarker(candidate.marker);
}
