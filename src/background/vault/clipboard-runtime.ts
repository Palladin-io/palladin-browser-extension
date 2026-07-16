/**
 * The real clipboard-wipe effect behind {@link ClipboardGuard}: ensure a
 * short-lived offscreen document exists (MV3 `CLIPBOARD` reason) and ask it to
 * empty the clipboard. This is the only supported way for a service worker,
 * which has no clipboard of its own, to clear one. Chrome-only glue — no unit
 * test; the scheduling decision it serves is tested in isolation.
 */

import { CLIPBOARD_CLEAR_MESSAGE } from "@shared/messaging";

const OFFSCREEN_URL = "src/offscreen/index.html";

let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: "Clear the clipboard after a copied secret's TTL elapses.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** Empty the clipboard via the offscreen document. Best-effort and value-free. */
export async function clearClipboard(): Promise<void> {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ channel: CLIPBOARD_CLEAR_MESSAGE });
}
