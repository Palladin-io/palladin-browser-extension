import { isCaptureDocumentRequest, type CaptureDocumentRequest, type CaptureDocumentReply } from '@shared/messaging/capture-document';
/** Private capture transport: never relayed through window.postMessage or page DOM. */
export function startCaptureDocument(owner: Window, documentId: string, connect: () => chrome.runtime.Port, handle: (request: CaptureDocumentRequest) => CaptureDocumentReply, onReady: () => void) {
    let port: chrome.runtime.Port | null = null, active = true, stopped = false, attempts = 0, unsupported = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const drop = () => { const old = port; port = null; try {
        old?.disconnect();
    }
    catch { /* Closed. */ } };
    const again = () => { if (!stopped && active && !unsupported && attempts < 20)
        retry = setTimeout(open, 250); };
    function open() {
        if (stopped || !active || unsupported || port)
            return;
        attempts++;
        let current: chrome.runtime.Port;
        try {
            current = connect();
        }
        catch {
            again();
            return;
        }
        port = current;
        let ready = false;
        current.onMessage.addListener((raw: unknown) => {
            if (port !== current || !active || stopped || !raw || typeof raw !== 'object' || Array.isArray(raw))
                return;
            const message = raw as Record<string, unknown>;
            if (message.type === 'unsupported') {
                unsupported = true;
                drop();
                return;
            }
            if (message.type === 'ready') {
                if (ready) {
                    drop();
                    return;
                }
                ready = true;
                attempts = 0;
                onReady();
                return;
            }
            if (message.type !== 'request' || !ready || message.documentId !== documentId || typeof message.requestId !== 'string' || message.requestId.length !== 36
                || typeof message.issuedAt !== 'number' || Date.now() < message.issuedAt || Date.now() - message.issuedAt >= 2000 || !isCaptureDocumentRequest(message.request))
                return;
            try {
                current.postMessage({ type: 'result', requestId: message.requestId, result: handle(message.request) });
            }
            catch {
                drop();
                again();
            }
        });
        current.onDisconnect.addListener(() => { if (typeof chrome !== 'undefined')
            void chrome.runtime.lastError; if (port !== current)
            return; port = null; again(); });
        try {
            current.postMessage({ type: 'hello', documentId });
        }
        catch {
            drop();
            again();
        }
    }
    const hide = () => { active = false; clearTimeout(retry); drop(); };
    const show = (event: Event) => { if ((event as PageTransitionEvent).persisted) {
        active = true;
        attempts = 0;
        open();
    } };
    owner.addEventListener('pagehide', hide);
    owner.addEventListener('pageshow', show);
    open();
    return { stop() { stopped = true; hide(); owner.removeEventListener('pagehide', hide); owner.removeEventListener('pageshow', show); } };
}
