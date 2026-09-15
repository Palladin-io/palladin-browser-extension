import { sharedUnlockOperationFrameSchema, type SharedUnlockOperationFrame } from "./shared-unlock-operation";
/** Private framing over an independently browser-authenticated route. */
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
export type SharedUnlockBrowserMessage = SharedUnlockBrowserHello | SharedUnlockBrowserReady | SharedUnlockOperationFrame;
const nonce = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
export function isSharedUnlockBrowserMessage(value: unknown): value is SharedUnlockBrowserMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.protocol !== SHARED_UNLOCK_BROWSER_PORT || !text(row.apiUrl, 2048) || !nonce(row.webNonce)) return false;
  const fields = Object.keys(row).sort().join(",");
  if (row.type === "operation") return sharedUnlockOperationFrameSchema.safeParse(row).success;
  if (row.type === "hello") return fields === "apiUrl,protocol,type,webNonce";
  if (row.type === "ready") return fields === "apiUrl,channelId,documentBinding,extensionId,protocol,type,webNonce,webOrigin"
    && nonce(row.channelId) && text(row.documentBinding, 256) && text(row.webOrigin, 2048)
    && isSharedUnlockExtensionId(row.extensionId);
  return false;
}

/** Syntax only; each adapter must compare with its independent configured or
 * browser-authored identity. Gecko also supports explicit UUID add-on IDs. */
export function isSharedUnlockExtensionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && (/^[a-p]{32}$/.test(value)
    || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(value)
    || /^\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}$/.test(value)
    || isSafariSharedUnlockExtensionId(value));
}

/** Syntax only; expected identity comes from runtime.id or explicit Web config. */
export function isSafariSharedUnlockExtensionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256
    && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+ \((?:[A-Z0-9]{10}|UNSIGNED)\)$/.test(value);
}
