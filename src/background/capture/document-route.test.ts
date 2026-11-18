import { expect, it, vi } from 'vitest';
import { CaptureDocumentRoutes } from './document-route';
const topId = 'a'.repeat(32), childId = 'b'.repeat(32);
function event<T extends unknown[]>() { const listeners = new Set<(...args: T) => void>(); return { addListener: (f: (...args: T) => void) => listeners.add(f), removeListener: (f: (...args: T) => void) => listeners.delete(f), emit: (...args: T) => { for (const f of [...listeners])
        f(...args); } }; }
async function settle() { for (let i = 0; i < 40; i++)
    await Promise.resolve(); }
function fixture() {
    const tab = { id: 7, incognito: false, status: 'complete', url: 'https://shop.test/pay' } as chrome.tabs.Tab;
    const probes = new Map([[0, { documentId: topId, url: tab.url! }], [2, { documentId: childId, url: 'https://pay.test/form' }]]);
    const deps = { extensionId: 'ext', getBrowserInfo: vi.fn(async () => ({ name: 'Firefox', version: '140.0' })), getTab: async () => tab, probe: vi.fn(async (_tab: number, frame: number) => probes.get(frame)), retired: vi.fn() };
    const routes = new CaptureDocumentRoutes(deps);
    function port(frameId = 0) { return { name: 'palladin.capture.document.v1', sender: { id: 'ext', frameId, origin: new URL(probes.get(frameId)!.url).origin, url: probes.get(frameId)!.url, tab }, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: event<[
            unknown
        ]>(), onDisconnect: event<[
        ]>() }; }
    async function register(frameId = 0) { const p = port(frameId); routes.register(p as unknown as chrome.runtime.Port); p.onMessage.emit({ type: 'hello', documentId: frameId ? childId : topId }); await settle(); return p; }
    return { routes, register, port, probes, deps, tab };
}
it('binds top and child captures to independently probed original Ports without inventing browser document IDs', async () => { const f = fixture(); const top = await f.register(); const child = await f.register(2); const source = await f.routes.resolveSource(childId, child.sender); expect(source).toMatchObject({ frameId: 2, documentId: childId }); expect(source?.browserDocumentId).toBeUndefined(); expect(source?.legacyRouteId).toBeTruthy(); expect(source?.legacyTopRouteId).toBeTruthy(); expect(await f.routes.current(source!)).toBe(true); top.onDisconnect.emit(); expect(await f.routes.current(source!)).toBe(false); });
it.each(['marker', 'origin', 'pending-navigation', 'incognito', 'disconnect'])('rejects stale %s before sending any seed', async (reason) => { const f = fixture(); const p = await f.register(); const s = (await f.routes.resolveSource(topId, p.sender))!; if (reason === 'marker')
    f.probes.set(0, { documentId: childId, url: f.tab.url! }); if (reason === 'origin')
    f.probes.set(0, { documentId: topId, url: 'https://other.test/' }); if (reason === 'pending-navigation')
    f.tab.pendingUrl = f.tab.url!; if (reason === 'incognito')
    f.tab.incognito = true; if (reason === 'disconnect')
    p.onDisconnect.emit(); expect(await f.routes.request(s, { channel: 'palladin.totp-capture', type: 'verify-page', expected: { secret: 'AAAAAAAA', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } }, () => true)).toBeNull(); expect(p.postMessage.mock.calls.flat().some(v => v.type === 'request')).toBe(false); });
it('rejects unsupported browser versions, wrong sender and orphan child', async () => { for (const version of ['139.0', '153.0']) {
    const f = fixture();
    f.deps.getBrowserInfo.mockResolvedValue({ name: 'Firefox', version });
    const p = await f.register();
    expect(await f.routes.resolveSource(topId, p.sender)).toBeNull();
} const f = fixture(); const child = await f.register(2); expect(await f.routes.resolveSource(childId, child.sender)).toBeNull(); });
it('rejects navigation while a current-document probe is pending and rejects a stale session', async () => { const f = fixture(); const p = await f.register(); const s = (await f.routes.resolveSource(topId, p.sender))!; expect(await f.routes.request(s, { channel: 'palladin.totp-capture', type: 'verify-page', expected: { secret: 'AAAAAAAA', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } }, () => false)).toBeNull(); let finish!: (v: {
    documentId: string;
    url: string;
} | undefined) => void; f.deps.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const result = f.routes.current(s); f.routes.retire(7); finish({ documentId: topId, url: f.tab.url! }); expect(await result).toBe(false); });
it('keeps a current top route during unrelated child-frame loading', async () => { const f = fixture(); const p = await f.register(); const source = (await f.routes.resolveSource(topId, p.sender))!; f.tab.status = 'loading'; expect(await f.routes.current(source)).toBe(true); });
it('sends generated values only to the exact original document Port after the session recheck', async () => {
    const f = fixture();
    const p = await f.register();
    const source = (await f.routes.resolveSource(topId, p.sender))!;
    const request = { channel: 'palladin.capture/fill' as const, expectedDocumentId: topId, expectedOrigin: 'https://shop.test', candidateId: 'candidate_0123456789', operationId: 'operation_0123456789', value: 'synthetic-generated' };
    const result = f.routes.request(source, request, () => true);
    await settle();
    const sent = p.postMessage.mock.calls.map(([value]) => value).find(value => value.type === 'request');
    expect(sent.request.value).toBe('synthetic-generated');
    expect(f.deps.probe.mock.calls.every(args => args.length === 2)).toBe(true);
    p.onMessage.emit({ type: 'result', requestId: sent.requestId, result: { ok: true } });
    expect(await result).toEqual({ ok: true });
    p.onDisconnect.emit();
    const next = await f.register();
    expect(await f.routes.request(source, request, () => true)).toBeNull();
    expect(next.postMessage.mock.calls.map(([value]) => value)).toEqual([{ type: 'ready' }]);
});
it('rechecks authorization after awaited probe and never sends the TOTP seed after lock', async () => {
    const f = fixture();
    const p = await f.register();
    const source = (await f.routes.resolveSource(topId, p.sender))!;
    let unlocked = true;
    f.deps.probe.mockImplementationOnce(async () => { unlocked = false; return { documentId: topId, url: f.tab.url! }; });
    expect(await f.routes.request(source, { channel: 'palladin.totp-capture', type: 'verify-page', expected: { secret: 'AAAA', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } }, () => unlocked)).toBeNull();
    expect(p.postMessage.mock.calls.map(([value]) => value)).toEqual([{ type: 'ready' }]);
});
it('rejects forged sender identity, document marker and child route after top replacement', async () => {
    const f = fixture();
    await f.register();
    const child = await f.register(2);
    const source = (await f.routes.resolveSource(childId, child.sender))!;
    expect(await f.routes.resolveSource(topId, child.sender)).toBeNull();
    expect(await f.routes.resolveSource(childId, { ...child.sender, id: 'other' })).toBeNull();
    await f.register();
    expect(await f.routes.current(source)).toBe(false);
});
it('reports the exact retired child frame and keeps the unrelated top route current', async () => {
    const f = fixture();
    const top = await f.register();
    const child = await f.register(2);
    const source = (await f.routes.resolveSource(topId, top.sender))!;
    child.onDisconnect.emit();
    expect(f.deps.retired).toHaveBeenCalledWith(7, expect.any(String), 2);
    expect(await f.routes.current(source)).toBe(true);
});
