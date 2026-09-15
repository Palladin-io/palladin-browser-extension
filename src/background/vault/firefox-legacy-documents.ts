import { isTabUrlResponse, type FillOutcome, type FillRequestMessage } from "@shared/messaging";
import { FIREFOX_LEGACY_FILL_PORT, isLegacyFillToWorker } from "../../shared/messaging/firefox-legacy-fill";
import type { ActiveTab } from "./commands";

export interface LegacyDocumentBrowser {
  readonly extensionId: string;
  getBrowserInfo(): Promise<{ name: string; version: string } | null>;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  probeCurrent(tabId: number): Promise<unknown>;
}
interface Registration {
  readonly port: chrome.runtime.Port;
  readonly tabId: number;
  readonly origin: string;
  readonly routeId: string;
  documentId: string | null;
  closed: boolean;
  ready: boolean;
  pending: { requestId: string; finish(outcome: FillOutcome): void } | null;
  close(): void;
}
const changed: FillOutcome = { ok: false, reason: "target-changed" };

/** Exact original Ports carry secrets; frame-addressed probes carry no secrets. */
export class FirefoxLegacyDocuments {
  private readonly connections = new Set<Registration>();
  private readonly current = new Map<number, Registration>();
  constructor(private readonly browser: LegacyDocumentBrowser) {}

  register(port: chrome.runtime.Port): void {
    if (port.name !== FIREFOX_LEGACY_FILL_PORT) return;
    const sender = port.sender;
    const origin = httpsOrigin(sender?.url);
    if (!sender || sender.id !== this.browser.extensionId || sender.frameId !== 0 || sender.documentId != null
      || sender.nativeApplication !== undefined || origin === null || sender.origin !== origin
      || sender.tab?.incognito !== false || !Number.isSafeInteger(sender.tab.id) || sender.tab.id! < 0
      || httpsOrigin(sender.tab.url) !== origin || this.connections.size >= 64) {
      try { port.postMessage({ type: "unsupported" }); port.disconnect(); } catch { /* closed */ } return;
    }
    const registeredAt = Date.now();
    let helloStarted = false;
    const registration: Registration = { port, tabId: sender.tab.id!, origin, routeId: crypto.randomUUID(),
      documentId: null, closed: false, ready: false, pending: null,
      close: () => {
        if (registration.closed) return;
        registration.closed = true; clearTimeout(timer);
        this.connections.delete(registration);
        if (this.current.get(registration.tabId) === registration) this.current.delete(registration.tabId);
        port.onMessage.removeListener(message); port.onDisconnect.removeListener(registration.close);
        registration.pending?.finish(changed); registration.pending = null;
        try { port.disconnect(); } catch { /* closed */ }
      } };
    const timer = setTimeout(registration.close, 5000);
    const message = (raw: unknown) => {
      if (!isLegacyFillToWorker(raw)) { registration.close(); return; }
      if (raw.type === "result") {
        if (!registration.ready || registration.pending?.requestId !== raw.requestId) { registration.close(); return; }
        registration.pending.finish(raw.outcome); return;
      }
      if (helloStarted) { registration.close(); return; }
      helloStarted = true; registration.documentId = raw.documentId;
      void (async () => {
        const info = await bounded(() => this.browser.getBrowserInfo());
        if (registration.closed) return;
        const major = Number(info?.version.match(/^(\d+)(?:\.|$)/)?.[1]);
        if (info?.name !== "Firefox" || !Number.isInteger(major) || major < 140 || major >= 153) {
          port.postMessage({ type: "unsupported" }); registration.close(); return;
        }
        await this.verify(registration, false);
        if (Date.now() < registeredAt || Date.now() - registeredAt >= 5000) throw new Error("Legacy document registration expired");
        this.current.get(registration.tabId)?.close();
        if (registration.closed) return;
        this.current.set(registration.tabId, registration); registration.ready = true;
        clearTimeout(timer); port.postMessage({ type: "ready" });
      })().catch(registration.close);
    };
    this.connections.add(registration);
    port.onMessage.addListener(message); port.onDisconnect.addListener(registration.close);
  }

  retire(tabId: number): void {
    for (const registration of [...this.connections]) if (registration.tabId === tabId) registration.close();
  }

  async resolve(tabId: number): Promise<ActiveTab | null> {
    const registration = this.current.get(tabId);
    if (!registration) return null;
    try {
      const url = await this.verify(registration);
      return { id: tabId, url, documentId: registration.documentId!,
        legacyFirefoxRouteId: registration.routeId, documentTransport: "legacy-firefox-port" };
    } catch { registration.close(); return null; }
  }

  async resolveSource(documentId: string, sender: chrome.runtime.MessageSender): Promise<ActiveTab | null> {
    if (sender.id !== this.browser.extensionId || sender.frameId !== 0 || sender.documentId != null
      || sender.nativeApplication !== undefined || sender.tab?.incognito !== false || !Number.isSafeInteger(sender.tab.id)
      || httpsOrigin(sender.url) === null || sender.origin !== httpsOrigin(sender.url)) return null;
    const target = await this.resolve(sender.tab.id!);
    return target && target.documentId === documentId && httpsOrigin(target.url) === httpsOrigin(sender.url) ? target : null;
  }

  async send(target: ActiveTab, request: FillRequestMessage, assertSessionCurrent: () => void): Promise<FillOutcome> {
    const registration = this.current.get(target.id);
    if (!registration || target.documentTransport !== "legacy-firefox-port" || target.legacyFirefoxRouteId !== registration.routeId
      || target.documentId !== registration.documentId || request.documentId !== registration.documentId
      || httpsOrigin(target.url) !== registration.origin || request.expectedOrigin !== registration.origin || registration.pending) return changed;
    try {
      assertSessionCurrent();
      await this.verify(registration);
      assertSessionCurrent();
      if (registration.pending) return changed;
      const requestId = crypto.randomUUID();
      return await bounded(() => new Promise<FillOutcome>((resolve, reject) => {
        registration.pending = { requestId, finish: outcome => { registration.pending = null; resolve(outcome); } };
        const copy = { ...request, fields: request.fields.map(field => ({ ...field })) };
        try { registration.port.postMessage({ type: "fill", requestId, issuedAt: Date.now(), request: copy }); }
        catch { reject(new Error("Legacy fill Port closed")); }
        finally { for (const field of copy.fields) field.value = ""; }
      }));
    } catch { registration.close(); return changed; }
  }

  private async verify(registration: Registration, requireCurrent = true): Promise<string> {
    const assertCurrent = () => {
      if (registration.closed || (requireCurrent && this.current.get(registration.tabId) !== registration)) throw new Error("Legacy document retired");
    };
    assertCurrent();
    const [tab, response] = await bounded(() => Promise.all([this.browser.getTab(registration.tabId), this.browser.probeCurrent(registration.tabId)]));
    assertCurrent();
    if (tab.id !== registration.tabId || tab.incognito !== false || tab.status !== "complete" || tab.discarded
      || (tab as chrome.tabs.Tab & { frozen?: boolean }).frozen || tab.pendingUrl !== undefined
      || httpsOrigin(tab.url) !== registration.origin || !isTabUrlResponse(response)
      || response.documentId !== registration.documentId || httpsOrigin(response.url) !== registration.origin) throw new Error("Legacy current document mismatch");
    return response.url;
  }
}
function httpsOrigin(value: unknown): string | null {
  try { if (typeof value !== "string") return null; const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  const started = Date.now(), monotonic = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Legacy document operation timed out")), 2000);
    })]);
    if (Date.now() < started || Date.now() - started >= 2000 || performance.now() - monotonic >= 2000) throw new Error("Legacy document operation expired");
    return result;
  } finally { clearTimeout(timer); }
}
