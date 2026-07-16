/**
 * Offscreen clipboard wiper. A service worker cannot touch the clipboard, so the
 * scheduled wipe (vault clipboard guard) delegates here: on the clear message we
 * overwrite the clipboard with an empty string via a hidden textarea +
 * `execCommand("copy")`, which works in an offscreen document without a user
 * gesture or focus. No value is ever read or logged.
 */

import { isClipboardClearMessage } from "@shared/messaging";

function wipeClipboard(): boolean {
  const sink = document.getElementById("sink");
  if (!(sink instanceof HTMLTextAreaElement)) return false;
  sink.value = "";
  sink.select();
  return document.execCommand("copy");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isClipboardClearMessage(message)) return undefined;
  sendResponse({ ok: wipeClipboard() });
  return undefined;
});
