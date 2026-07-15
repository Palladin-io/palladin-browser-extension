/**
 * The clipboard-wipe message from the service worker to its offscreen document.
 *
 * A service worker has no clipboard, so the scheduled wipe (see the vault
 * clipboard guard) is delegated to a short-lived offscreen document created with
 * the `CLIPBOARD` reason. This is the one message it understands; it carries no
 * data (the wipe writes an empty string, never a value).
 */

export const CLIPBOARD_CLEAR_MESSAGE = "palladin.clipboard/clear" as const;

export interface ClipboardClearMessage {
  readonly channel: typeof CLIPBOARD_CLEAR_MESSAGE;
}

export function isClipboardClearMessage(value: unknown): value is ClipboardClearMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { channel?: unknown }).channel === CLIPBOARD_CLEAR_MESSAGE
  );
}
