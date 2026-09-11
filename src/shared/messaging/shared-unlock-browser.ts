/** Private first-party framing over a browser-authenticated external Port. */
export const SHARED_UNLOCK_BROWSER_PORT = "palladin.shared-unlock.browser.v1";
export interface SharedUnlockBrowserHello {
  readonly type: "hello";
  readonly protocol: typeof SHARED_UNLOCK_BROWSER_PORT;
  readonly apiUrl: string;
  /** Request correlation only; never a crypto-session/source-authorization generation. */
  readonly webNonce: string;
}
export interface SharedUnlockBrowserReady {
  readonly type: "ready";
  readonly protocol: typeof SHARED_UNLOCK_BROWSER_PORT;
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly webNonce: string;
  readonly channelId: string;
  readonly documentBinding: string;
}
export type SharedUnlockBrowserMessage = SharedUnlockBrowserHello | SharedUnlockBrowserReady;
const nonce = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
export function isSharedUnlockBrowserMessage(value: unknown): value is SharedUnlockBrowserMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.protocol !== SHARED_UNLOCK_BROWSER_PORT || !text(row.apiUrl, 2048) || !nonce(row.webNonce)) return false;
  const fields = Object.keys(row).sort().join(",");
  if (row.type === "hello") return fields === "apiUrl,protocol,type,webNonce";
  if (row.type === "ready") return fields === "apiUrl,channelId,documentBinding,extensionId,protocol,type,webNonce,webOrigin"
    && nonce(row.channelId) && text(row.documentBinding, 256) && text(row.webOrigin, 2048)
    && typeof row.extensionId === "string" && /^[a-p]{32}$/.test(row.extensionId);
  return false;
}
