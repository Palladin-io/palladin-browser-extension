import { isTabUrlResponse } from '@shared/messaging';
import { CAPTURE_DOCUMENT_PORT, isCaptureDocumentReply, type CaptureDocumentRequest, type CaptureDocumentReply } from '@shared/messaging/capture-document';
import { isLegacyDocumentId } from '@shared/messaging/firefox-legacy-fill';
import type { SecretCaptureSource } from './secret-coordinator';
interface Dependencies {
    extensionId: string;
    getBrowserInfo(): Promise<{
        name: string;
        version: string;
    } | null>;
    getTab(tabId: number): Promise<chrome.tabs.Tab>;
    probe(tabId: number, frameId: number): Promise<unknown>;
    retired(tabId: number, routeId: string, frameId: number): void;
    connected?(source: SecretCaptureSource): void;
}
interface Registration {
    port: chrome.runtime.Port;
    tabId: number;
    frameId: number;
    origin: string;
    routeId: string;
    documentId: string | null;
    topRouteId: string | null;
    closed: boolean;
    ready: boolean;
    close(): void;
    pending: {
        id: string;
        finish(value: CaptureDocumentReply | null): void;
    } | null;
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: string[]) => Object.keys(x).sort().join() === names.sort().join();
function origin(raw: unknown): string | null { try {
    if (typeof raw !== 'string')
        return null;
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
}
catch {
    return null;
} }
/** Capture-only original Ports. Independent frame probes carry no captured values. */
export class CaptureDocumentRoutes {
    private readonly registrations = new Set<Registration>();
    private readonly currentFrames = new Map<string, Registration>();
    constructor(private readonly deps: Dependencies) { }
    register(port: chrome.runtime.Port): void {
        const sender = port.sender, site = origin(sender?.url);
        const reject = () => { try {
            port.postMessage({ type: 'unsupported' });
            port.disconnect();
        }
        catch { /* Closed. */ } };
        if (port.name !== CAPTURE_DOCUMENT_PORT || !sender || sender.id !== this.deps.extensionId || sender.documentId != null || sender.nativeApplication !== undefined
            || !Number.isSafeInteger(sender.frameId) || sender.frameId! < 0 || sender.tab?.incognito !== false || !Number.isSafeInteger(sender.tab.id) || sender.tab.id! < 0
            || !site || sender.origin !== site || !origin(sender.tab.url) || this.registrations.size >= 64) {
            reject();
            return;
        }
        const key = `${sender.tab.id}:${sender.frameId}`;
        const registration: Registration = { port, tabId: sender.tab.id!, frameId: sender.frameId!, origin: site, routeId: crypto.randomUUID(), documentId: null, topRouteId: null, closed: false, ready: false, pending: null,
            close: () => {
                if (registration.closed)
                    return;
                registration.closed = true;
                clearTimeout(timer);
                this.registrations.delete(registration);
                if (this.currentFrames.get(key) === registration)
                    this.currentFrames.delete(key);
                port.onMessage.removeListener(message);
                port.onDisconnect.removeListener(registration.close);
                registration.pending?.finish(null);
                registration.pending = null;
                this.deps.retired(registration.tabId, registration.routeId, registration.frameId);
                if (registration.frameId === 0)
                    for (const child of [...this.registrations])
                        if (child.tabId === registration.tabId && child.topRouteId === registration.routeId)
                            child.close();
                try {
                    port.disconnect();
                }
                catch { /* Closed. */ }
            } };
        const timer = setTimeout(registration.close, 5000);
        const message = (raw: unknown) => {
            if (!record(raw)) {
                registration.close();
                return;
            }
            if (raw.type === 'result' && keys(raw, ['type', 'requestId', 'result']) && isCaptureDocumentReply(raw.result)) {
                if (!registration.ready || registration.pending?.id !== raw.requestId) {
                    registration.close();
                    return;
                }
                registration.pending!.finish(raw.result);
                return;
            }
            if (!keys(raw, ['type', 'documentId']) || raw.type !== 'hello' || !isLegacyDocumentId(raw.documentId) || registration.documentId !== null) {
                registration.close();
                return;
            }
            registration.documentId = raw.documentId;
            void (async () => {
                const info = await bounded(() => this.deps.getBrowserInfo());
                const version = Number(info?.version.match(/^(\d+)(?:\.|$)/)?.[1]);
                if (info?.name !== 'Firefox' || !Number.isInteger(version) || version < 140 || version >= 153)
                    throw Error('Unsupported capture document transport');
                if (registration.frameId === 0)
                    registration.topRouteId = registration.routeId;
                else {
                    const top = this.currentFrames.get(`${registration.tabId}:0`);
                    if (!top?.ready)
                        throw Error('Missing top capture document');
                    registration.topRouteId = top.routeId;
                }
                const url = await this.verify(registration, false);
                this.currentFrames.get(key)?.close();
                if (registration.closed)
                    return;
                this.currentFrames.set(key, registration);
                registration.ready = true;
                clearTimeout(timer);
                port.postMessage({ type: 'ready' });
                this.deps.connected?.(this.source(registration, url));
            })().catch(registration.close);
        };
        this.registrations.add(registration);
        port.onMessage.addListener(message);
        port.onDisconnect.addListener(registration.close);
    }
    retire(tabId: number): void { for (const item of [...this.registrations])
        if (item.tabId === tabId)
            item.close(); }
    clear(): void { for (const item of [...this.registrations])
        item.close(); }
    isRegistered(source: {
        tabId: number;
        legacyRouteId?: string;
    }): boolean { return [...this.registrations].some(r => r.ready && !r.closed && r.tabId === source.tabId && r.routeId === source.legacyRouteId); }
    async resolve(tabId: number, frameId = 0): Promise<SecretCaptureSource | null> { const r = this.currentFrames.get(`${tabId}:${frameId}`); if (!r)
        return null; try {
        return this.source(r, await this.verify(r));
    }
    catch {
        r.close();
        return null;
    } }
    async resolveSource(documentId: string, sender: chrome.runtime.MessageSender): Promise<SecretCaptureSource | null> {
        if (sender.id !== this.deps.extensionId || sender.documentId != null || sender.nativeApplication !== undefined || sender.tab?.incognito !== false || !Number.isSafeInteger(sender.tab.id)
            || !Number.isSafeInteger(sender.frameId) || sender.frameId! < 0 || origin(sender.url) === null || sender.origin !== origin(sender.url))
            return null;
        const source = await this.resolve(sender.tab.id!, sender.frameId);
        return source?.documentId === documentId && origin(source.url) === origin(sender.url) ? source : null;
    }
    async current(source: SecretCaptureSource): Promise<boolean> {
        const r = this.currentFrames.get(`${source.tabId}:${source.frameId}`);
        if (!r || r.routeId !== source.legacyRouteId || r.topRouteId !== source.legacyTopRouteId || r.documentId !== source.documentId)
            return false;
        try {
            return await this.verify(r) === source.url;
        }
        catch {
            r.close();
            return false;
        }
    }
    async request(source: SecretCaptureSource, request: CaptureDocumentRequest, authorized: () => boolean): Promise<CaptureDocumentReply | null> {
        const r = this.currentFrames.get(`${source.tabId}:${source.frameId}`);
        if (!r || r.pending || !authorized() || !await this.current(source) || !authorized() || r.closed || r.pending)
            return null;
        try {
            return await bounded(() => new Promise<CaptureDocumentReply | null>((resolve, reject) => {
                const id = crypto.randomUUID();
                r.pending = { id, finish: value => { r.pending = null; resolve(value); } };
                try {
                    r.port.postMessage({ type: 'request', requestId: id, issuedAt: Date.now(), documentId: source.documentId, request });
                }
                catch {
                    reject(Error('Capture Port closed'));
                }
            }));
        }
        catch {
            r.close();
            return null;
        }
    }
    private source(r: Registration, url: string): SecretCaptureSource { return { tabId: r.tabId, frameId: r.frameId, documentId: r.documentId!, url, legacyRouteId: r.routeId, legacyTopRouteId: r.topRouteId! }; }
    private async verify(r: Registration, requireCurrent = true): Promise<string> {
        const assert = () => { if (r.closed || requireCurrent && this.currentFrames.get(`${r.tabId}:${r.frameId}`) !== r)
            throw Error('Capture route retired'); };
        assert();
        const top = r.frameId === 0 ? r : this.currentFrames.get(`${r.tabId}:0`);
        if (!top || top.closed || top.routeId !== r.topRouteId)
            throw Error('Capture top changed');
        const [tab, frame, topFrame] = await bounded(() => Promise.all([this.deps.getTab(r.tabId), this.deps.probe(r.tabId, r.frameId), r.frameId === 0 ? Promise.resolve(null) : this.deps.probe(r.tabId, 0)]));
        assert();
        if (top.closed || r.frameId !== 0 && this.currentFrames.get(`${r.tabId}:0`) !== top)
            throw Error('Capture top retired');
        if (tab.id !== r.tabId || tab.incognito !== false || tab.discarded || (tab as chrome.tabs.Tab & {
            frozen?: boolean;
        }).frozen || tab.pendingUrl !== undefined
            || origin(tab.url) !== top.origin || !isTabUrlResponse(frame) || frame.documentId !== r.documentId || origin(frame.url) !== r.origin
            || r.frameId !== 0 && (!isTabUrlResponse(topFrame) || topFrame.documentId !== top.documentId || origin(topFrame.url) !== top.origin))
            throw Error('Capture document changed');
        return frame.url;
    }
}
async function bounded<T>(operation: () => Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; const start = performance.now(), wall = Date.now(); try {
    const result = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Capture document timed out')), 2000); })]);
    if (performance.now() - start >= 2000 || Date.now() < wall || Date.now() - wall >= 2000)
        throw Error('Capture document expired');
    return result;
}
finally {
    clearTimeout(timer);
} }
