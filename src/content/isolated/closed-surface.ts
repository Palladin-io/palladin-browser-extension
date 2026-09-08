import { createAgentInjectDomAccess } from "./agent-inject";

export function createClosedSurface(doc: Document, name: "palladin-autofill" | "palladin-capture") {
  const host = doc.createElement(name);
  const properties: Record<string, string> = {
    all: "initial",
    "font-family": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    "font-size": "16px", "line-height": "1.4", "font-synthesis": "none",
    position: "fixed", "z-index": "2147483647", "pointer-events": "none",
    animation: "none", transition: "none",
  };
  for (const [key, value] of Object.entries(properties)) host.style.setProperty(key, value, "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const dom = createAgentInjectDomAccess(doc);
  return {
    host,
    shadow,
    acceptsAction(event: MouseEvent, control: HTMLElement): boolean {
      if (!event.isTrusted || !host.isConnected || !dom.isVisible(host) || !shadow.contains(control)) return false;
      if (event.detail === 0) return doc.activeElement === host && shadow.activeElement === control;
      return doc.elementFromPoint(event.clientX, event.clientY) === host
        && shadow.elementFromPoint(event.clientX, event.clientY) === control;
    },
  };
}
