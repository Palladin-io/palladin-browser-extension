interface FirefoxDocumentGlobal {
  __palladinFirefoxDocumentV1?: { marker: string | null };
}

/** The isolated world's global is independent of page-world properties. */
export function installFirefoxDocumentMarker(owner: Window, isolated: object, newId: () => string = () => crypto.randomUUID()): void {
  if ((isolated as FirefoxDocumentGlobal).__palladinFirefoxDocumentV1) return;
  const state = { marker: newId() as string | null };
  Object.defineProperty(isolated, "__palladinFirefoxDocumentV1", { value: state });
  owner.addEventListener("pagehide", () => { state.marker = null; });
  owner.addEventListener("pageshow", event => { if ((event as PageTransitionEvent).persisted) state.marker = newId(); });
}

/** Serialized by scripting.executeScript; all references must be local. */
export function readFirefoxDocumentMarker(): string | null {
  return (globalThis as FirefoxDocumentGlobal).__palladinFirefoxDocumentV1?.marker ?? null;
}
