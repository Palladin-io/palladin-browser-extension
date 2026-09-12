import type { SurfaceActivity } from "../../shared/messaging/surface-activity";

const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"] as const;
/** Browser-authored input in the isolated popup/side-panel document only.
 * Mount, visibility, status polling, rendering and liveness never send activity. */
export function startSurfaceActivity(target: Window, send: (message: SurfaceActivity) => Promise<unknown>, now: () => number = Date.now): () => void {
  let last = -Infinity;
  let active = true;
  const record = (event: Event) => {
    if (!active || !event.isTrusted) return;
    const observedAt = now();
    if (observedAt - last < 1_000) return;
    last = observedAt;
    try { void send({ channel: "palladin.session/activity", type: "activity", observedAt }).catch(() => {}); }
    catch { /* A closed extension context cannot retain or retry activity. */ }
  };
  for (const event of events) target.addEventListener(event, record, { passive: true });
  return () => { active = false; for (const event of events) target.removeEventListener(event, record); };
}
