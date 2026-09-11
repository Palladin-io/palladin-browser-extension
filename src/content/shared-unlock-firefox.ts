import { FIREFOX_SHARED_UNLOCK_CANDIDATE, FIREFOX_SHARED_UNLOCK_DISCOVER } from "../shared/messaging/shared-unlock-firefox";

// A discovery hint only. The Web verifies canonical browser resource identity
// and exact iframe origin/source before any protocol or key-bearing exchange.
if (window === window.top && __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__.some(item => item.webOrigin === location.origin)) {
  let lastReply = -Infinity;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin || event.data === null || typeof event.data !== "object"
      || Array.isArray(event.data) || Object.keys(event.data).join(",") !== "type"
      || (event.data as { type?: unknown }).type !== FIREFOX_SHARED_UNLOCK_DISCOVER || performance.now() - lastReply < 500) return;
    lastReply = performance.now();
    const root = chrome.runtime.getURL("");
    window.postMessage({ type: FIREFOX_SHARED_UNLOCK_CANDIDATE, origin: root.replace(/\/$/, "") }, location.origin);
  });
}
