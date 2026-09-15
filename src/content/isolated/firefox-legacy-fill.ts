import { isLegacyFillToDocument } from "../../shared/messaging/firefox-legacy-fill";
import type { FillOutcome, FillRequestMessage } from "../../shared/messaging/fill";

/** This Port has no page relay and never queues a secret for later use. */
export function startLegacyFirefoxFill(owner: Window, documentId: string, connect: () => chrome.runtime.Port,
  consumeError: () => void, fill: (request: FillRequestMessage) => FillOutcome, onReady: () => void) {
  let current: chrome.runtime.Port | null = null;
  let active = true, stopped = false, unsupported = false, attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const drop = () => { const old = current; current = null; try { old?.disconnect(); } catch { /* closed */ } };
  const retryConnection = () => {
    if (active && !stopped && !unsupported && attempts < 8) retry = setTimeout(open, 250);
  };
  function open(): void {
    if (!active || stopped || unsupported || current) return;
    attempts += 1;
    let next: chrome.runtime.Port;
    try { next = connect(); } catch { retryConnection(); return; }
    current = next;
    let accepted = false;
    next.onMessage.addListener((raw: unknown) => {
      if (current !== next) {
        if (isLegacyFillToDocument(raw) && raw.type === "fill") {
          for (const field of raw.request.fields) (field as { value: string }).value = "";
        }
        return;
      }
      if (!isLegacyFillToDocument(raw)) { unsupported = true; drop(); return; }
      if (raw.type === "fill") {
        try {
          if (current !== next || !active || stopped || !accepted || raw.request.documentId !== documentId
            || Date.now() < raw.issuedAt || Date.now() - raw.issuedAt >= 2000) return;
          const outcome = fill(raw.request);
          next.postMessage({ type: "result", requestId: raw.requestId, outcome });
        } catch { drop(); retryConnection(); }
        finally { for (const field of raw.request.fields) (field as { value: string }).value = ""; }
        return;
      }
      if (current !== next || !active || stopped) return;
      if (raw.type === "unsupported") { unsupported = true; drop(); return; }
      if (accepted) { unsupported = true; drop(); return; }
      accepted = true; attempts = 0; onReady();
    });
    next.onDisconnect.addListener(() => {
      consumeError();
      if (current !== next) return;
      current = null; retryConnection();
    });
    try { next.postMessage({ type: "hello", documentId }); } catch { drop(); retryConnection(); }
  }
  const hide = () => { active = false; clearTimeout(retry); drop(); };
  const show = (event: Event) => { if ((event as PageTransitionEvent).persisted) { active = true; attempts = 0; open(); } };
  owner.addEventListener("pagehide", hide); owner.addEventListener("pageshow", show);
  open();
  return { stop() { stopped = true; hide(); owner.removeEventListener("pagehide", hide); owner.removeEventListener("pageshow", show); } };
}
