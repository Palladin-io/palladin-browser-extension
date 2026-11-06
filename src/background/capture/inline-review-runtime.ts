import { captureTopDocumentKey } from './document-identity';
import { InlineCaptureReviewSessions, inlineDocumentLifecycle, type InlineCaptureReviewDependencies } from './inline-review';
import { isInlineCaptureReviewCommand, type InlineCaptureKind, type InlineCaptureReviewResult } from '../../shared/messaging/inline-capture-review';
import { isManualEntrySaveInput } from '../vault/commands';
import type { SecretCaptureSource } from './secret-coordinator';
export const INLINE_REVIEW_OWNER_PORT = 'palladin.inline-capture-review.owner.v1';
export const INLINE_REVIEW_FRAME_PORT = 'palladin.inline-capture-review.frame.v1';
interface Gesture { x: number; y: number; keyboard: boolean; at: number }
const record = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const only = (raw: Record<string, unknown>, keys: string[]) => Object.keys(raw).every(key => keys.includes(key));
const id = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0 && raw.length <= 256;
export function validInlineReviewGesture(raw: unknown, now = Date.now()): raw is Gesture {
  return record(raw) && only(raw, ['x','y','keyboard','at']) && typeof raw.x === 'number' && Number.isFinite(raw.x) && raw.x >= 0
    && typeof raw.y === 'number' && Number.isFinite(raw.y) && raw.y >= 0 && typeof raw.keyboard === 'boolean'
    && typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at <= now && now - raw.at <= 1500;
}
interface Dependencies extends Omit<InlineCaptureReviewDependencies, 'attest'> {
  withOperation<T>(operation: () => Promise<T>): Promise<T>;
  onSaved(): void;
  apiUrl(): string;
}
interface Owner { port: chrome.runtime.Port; documentId: string; tabId: number }
export function createInlineCaptureReviewRuntime(deps: Dependencies) {
  const owners = new Map<string, Owner>();
  const ports = new Set<chrome.runtime.Port>();
  const gestures = new Map<chrome.runtime.Port, Gesture>();
  const bindings = new Map<string, { owner: chrome.runtime.Port; frame: chrome.runtime.Port; nonce: string; settle(ok: boolean): void }>();
  const challenges = new Map<string, { owner: chrome.runtime.Port; settle(ok: boolean): void }>();
  const sourceKey = (tabId: number, documentId: string) => `${tabId}:${documentId}`;
  const send = (port: chrome.runtime.Port, message: object) => { try { port.postMessage(message); } catch { /* A disconnected document has no response recipient. */ } };
  const sessions = new InlineCaptureReviewSessions({ ...deps, verifyFrameParent: async (frame, source) => {
    if (!await deps.verifyFrameParent(frame, source)) return false;
    const owner = owners.get(sourceKey(source.tabId, captureTopDocumentKey(source)));
    const framePort = [...ports].find(port => port.name === INLINE_REVIEW_FRAME_PORT && port.sender === frame);
    if (!owner || !framePort || owner.documentId !== source.documentId) return false;
    const requestId = crypto.randomUUID(), nonce = crypto.randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => settle(false), 2000);
      function settle(ok: boolean) { clearTimeout(timer); bindings.delete(requestId); resolve(ok); }
      bindings.set(requestId, { owner: owner.port, frame: framePort, nonce, settle });
      send(framePort, { type: 'binding-challenge', requestId, nonce });
    });
  }, attest: (source, frame, phase) => {
    const owner = owners.get(sourceKey(source.tabId, captureTopDocumentKey(source)));
    if (!owner || owner.documentId !== source.documentId) return Promise.resolve(false);
    const requestId = crypto.randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => settle(false), 2000);
      function settle(ok: boolean) { clearTimeout(timer); challenges.delete(requestId); resolve(ok); }
      challenges.set(requestId, { owner: owner.port, settle });
      const framePort = frame ? [...ports].find(port => port.sender === frame) : undefined;
      const gesture = framePort ? gestures.get(framePort) : undefined;
      send(owner.port, { type: 'attest', requestId, phase, ...(gesture ? { gesture } : {}) });
    });
  } });
  function revokePort(port: chrome.runtime.Port) {
    sessions.revokeOwner(port); ports.delete(port);
    for (const binding of bindings.values()) if (binding.owner === port || binding.frame === port) binding.settle(false);
    for (const [key, owner] of owners) if (owner.port === port) owners.delete(key);
    for (const challenge of challenges.values()) if (challenge.owner === port) challenge.settle(false);
    gestures.delete(port);
  }
  function close(port: chrome.runtime.Port) { send(port, { type: 'invalidated' }); revokePort(port); try { port.disconnect(); } catch { /* Already closed. */ } }
  return {
    clear() { sessions.clear(); for (const port of [...ports]) close(port); },
    revokeTab(tabId: number) { sessions.revokeTab(tabId); for (const port of [...ports]) if (port.sender?.tab?.id === tabId) close(port); },
    connect(port: chrome.runtime.Port): boolean {
      if (port.name !== INLINE_REVIEW_OWNER_PORT && port.name !== INLINE_REVIEW_FRAME_PORT) return false;
      const sender = port.sender;
      if (!sender || sender.id !== deps.runtimeId || !Number.isInteger(sender.tab?.id) || (!sender.documentId && !deps.frameUrl.startsWith('moz-extension://')) || !inlineDocumentLifecycle(deps.frameUrl, sender.documentLifecycle) || sender.tab?.incognito) { port.disconnect(); return true; }
      ports.add(port);
      port.onDisconnect.addListener(() => {
        const owner = port.name === INLINE_REVIEW_OWNER_PORT;
        revokePort(port);
        if (owner) for (const other of [...ports]) if (other.sender?.tab?.id === sender.tab!.id) close(other);
      });
      if (port.name === INLINE_REVIEW_OWNER_PORT) {
        let https = false; try { https = new URL(sender.url ?? '').protocol === 'https:'; } catch { /* Invalid sender URL. */ }
        if (sender.frameId !== 0 || !https) { close(port); return true; }

        let minting = false;
        port.onMessage.addListener((raw: unknown) => {
          if (!record(raw)) return;
          if (raw.type === 'binding-proof' && only(raw, ['type','requestId','nonce']) && id(raw.requestId) && id(raw.nonce)) {
            const binding = bindings.get(raw.requestId);
            if (binding?.owner === port) binding.settle(raw.nonce === binding.nonce);
            return;
          }
          if (raw.type === 'attested' && only(raw, ['type','requestId','ok']) && id(raw.requestId) && typeof raw.ok === 'boolean') {
            const challenge = challenges.get(raw.requestId);
            if (challenge?.owner === port) challenge.settle(raw.ok);
            return;
          }
          if (raw.type !== 'mint' || !only(raw, ['type','kind','captureId','documentId']) || minting || !ports.has(port)
            || !['login','secret','totp'].includes(String(raw.kind)) || !id(raw.captureId) || !id(raw.documentId)) return;
          minting = true;
          void deps.withOperation(async () => {
            const documentId = raw.documentId as string;
            const source = deps.resolveSource ? await deps.resolveSource(sender, documentId) : sender.documentId ? {topDocumentId:sender.documentId} : null;
            if (!source || !ports.has(port)) return null;
            const key = sourceKey(sender.tab!.id!, captureTopDocumentKey(source));
            if (!captureTopDocumentKey(source)) return null;
            const previous = owners.get(key); if (previous && previous.port !== port) close(previous.port);
            owners.set(key, {port,documentId,tabId:sender.tab!.id!});
            return sessions.mint(sender, { kind: raw.kind as InlineCaptureKind, captureId: raw.captureId as string, documentId }, port);
          })
            .then(capability => send(port, { type: 'minted', capability }))
            .catch(() => send(port, { type: 'minted', capability: null })).finally(() => { minting = false; });
        });
        return true;
      }
      let connected = false, busy = false;
      port.onMessage.addListener((raw: unknown) => {
        if (!record(raw)) return;
        if (raw.type === 'connect' && only(raw, ['type','capability']) && id(raw.capability) && !connected && !busy) {
          busy = true;
          void sessions.connect(raw.capability, sender, port).then(ok => { connected = ok; send(port, { type: 'connected', ok, ...(ok ? { apiUrl: deps.apiUrl() } : {}) }); })
            .catch(() => send(port, { type: 'connected', ok: false })).finally(() => { busy = false; });
          return;
        }
        if (raw.type !== 'command' || !only(raw, ['type','requestId','envelope','gesture']) || !id(raw.requestId)) return;
        const requestId = raw.requestId;
        const stale = () => send(port, { type: 'result', requestId, result: { status: 'stale' } });
        if (!connected || busy || !ports.has(port) || !isInlineCaptureReviewCommand(raw.envelope, isManualEntrySaveInput)) { stale(); return; }
        const envelope = raw.envelope;
        const mutation = !['get','check','begin-review'].includes(envelope.command.type);
        if (mutation && !validInlineReviewGesture(raw.gesture)) { stale(); return; }
        if (mutation) gestures.set(port, raw.gesture as Gesture);
        busy = true;
        void deps.withOperation(() => sessions.dispatch(envelope, sender, port)).then((result: InlineCaptureReviewResult) => {
          send(port, { type: 'result', requestId, result });
          if (result.status === 'saved') deps.onSaved();
        }).catch(stale).finally(() => { gestures.delete(port); busy = false; });
      });
      return true;
    },
  };
}

/** Top identity is browser-authored; the separate dual-Port challenge binds the owned child. */
export async function verifyInlineReviewFrame(frame: chrome.runtime.MessageSender, source: SecretCaptureSource): Promise<boolean> {
  if (!chrome.webNavigation?.getFrame || frame.tab?.id !== source.tabId || frame.frameId === undefined) return false;
  try {
    const [top, tab] = await Promise.all([chrome.webNavigation.getFrame({ tabId: source.tabId, frameId: 0 }), chrome.tabs.get(source.tabId)]);
    return !!top && top.parentFrameId === -1 && !top.errorOccurred && top.documentId === source.topDocumentId
      && inlineDocumentLifecycle(frame.url ?? '', top.documentLifecycle) && top.url === source.url
      && tab.id === source.tabId && tab.incognito === false && tab.status === 'complete' && !tab.discarded
      && !(tab as chrome.tabs.Tab & {frozen?:boolean}).frozen && tab.pendingUrl === undefined && (tab.url === undefined || tab.url === source.url);
  } catch { return false; }
}
