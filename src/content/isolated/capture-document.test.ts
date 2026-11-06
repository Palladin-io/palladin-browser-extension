import { expect, it, vi } from 'vitest';
import { startCaptureDocument } from './capture-document';
function event<T extends unknown[]>() { const ls = new Set<(...args: T) => void>(); return { addListener: (f: (...args: T) => void) => ls.add(f), removeListener: (f: (...args: T) => void) => ls.delete(f), emit: (...args: T) => { for (const f of ls)
        f(...args); } }; }
it('accepts sensitive verification only on the ready original Port and drops it on pagehide', () => { const owner = new EventTarget() as Window; const p = { postMessage: vi.fn(), disconnect: vi.fn(), onMessage: event<[
        unknown
    ]>(), onDisconnect: event<[
    ]>() }; const handle = vi.fn(() => true); const route = startCaptureDocument(owner, 'a'.repeat(32), () => p as unknown as chrome.runtime.Port, handle, () => { }); const message = { type: 'request', requestId: crypto.randomUUID(), documentId: 'a'.repeat(32), issuedAt: Date.now(), request: { channel: 'palladin.totp-capture', type: 'verify-page', expected: { secret: 'AAAA', algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } } }; p.onMessage.emit(message); expect(handle).not.toHaveBeenCalled(); p.onMessage.emit({ type: 'ready' }); p.onMessage.emit(message); expect(handle).toHaveBeenCalledTimes(1); owner.dispatchEvent(new Event('pagehide')); p.onMessage.emit({ ...message, requestId: crypto.randomUUID() }); expect(handle).toHaveBeenCalledTimes(1); route.stop(); });
