/** Public, value-free request used when `activeTab` does not expose `tab.url`. */
export const TAB_URL_REQUEST_CHANNEL = "palladin.tab/current-url" as const;

export interface TabUrlRequestMessage {
  readonly channel: typeof TAB_URL_REQUEST_CHANNEL;
}

export interface TabUrlResponse {
  readonly url: string;
  /** Isolated-world page-load identifier; never forwarded to the native host. */
  readonly documentId: string;
}

export function isTabUrlRequestMessage(value: unknown): value is TabUrlRequestMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 1 && message.channel === TAB_URL_REQUEST_CHANNEL;
}

export function isTabUrlResponse(value: unknown): value is TabUrlResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return Object.keys(response).length === 2
    && typeof response.url === "string"
    && response.url.length > 0
    && response.url.length <= 8_192
    && typeof response.documentId === "string"
    && /^[a-f0-9]{32}$/.test(response.documentId);
}
