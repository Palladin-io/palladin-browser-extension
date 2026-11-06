import { INLINE_CAPTURE_REVIEW_CHANNEL, type InlineCaptureKind, type InlineCaptureNavigation, type InlineCaptureReviewResult } from '../shared/messaging/inline-capture-review';
import type { NativeLoginCaptureCommand } from '../shared/messaging/native-login-capture';
import type { SecretCapturePopupCommand } from '../shared/messaging/secret-capture';
import type { TotpPopupCommand } from '../shared/messaging/totp-capture';

type CaptureCommand = InlineCaptureNavigation | NativeLoginCaptureCommand | SecretCapturePopupCommand | TotpPopupCommand;
interface Gesture { x: number; y: number; keyboard: boolean; at: number }
export interface CaptureFrameConnection {
  kind: InlineCaptureKind;
  apiUrl: string | null;
  send(command: CaptureCommand): Promise<InlineCaptureReviewResult>;
  ready(): void;
  failed(): void;
  resize(height: number): void;
  close(): void;
}

export function bindCaptureFrame(
  win: Window,
  connect: () => chrome.runtime.Port,
  onReady: (connection: CaptureFrameConnection) => void,
  onClear: () => void,
): () => void {
  let booted = false, closed = false, authorized = false;
  let runtime: chrome.runtime.Port | undefined, parentPort: MessagePort | undefined;
  let gesture: Gesture | undefined;
  let requestId = 0;
  const pending = new Map<string, { resolve(value: InlineCaptureReviewResult): void; reject(reason: Error): void }>();
  const clear = () => {
    if (closed) return;
    closed = true; authorized = false; gesture = undefined;
    for (const request of pending.values()) request.reject(new Error('Capture frame disconnected'));
    pending.clear(); onClear();
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const keyboard = event.detail === 0;
    const box = keyboard ? (event.target as Element | null)?.getBoundingClientRect?.() : null;
    gesture = { x: box ? box.x + box.width / 2 : event.clientX, y: box ? box.y + box.height / 2 : event.clientY, keyboard, at: Date.now() };
  };
  const close = () => {
    if (closed) return;
    parentPort?.postMessage({ type: 'close' }); clear(); runtime?.disconnect();
  };
  const key = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!event.isTrusted || !['Enter', ' '].includes(event.key)) return;
    const box = (event.target as Element | null)?.getBoundingClientRect?.();
    if (box) gesture = { x: box.x + box.width / 2, y: box.y + box.height / 2, keyboard: true, at: Date.now() };
  };
  const boot = (event: MessageEvent) => {
    if (booted || closed || event.source !== win.parent || event.ports.length !== 1) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object' || !('channel' in data) || data.channel !== 'palladin.inline-capture-review.boot.v1'
      || !('capability' in data) || typeof data.capability !== 'string' || !/^[a-f0-9]{64}$/.test(data.capability)
      || !('kind' in data) || !['login', 'secret', 'totp'].includes(String(data.kind))) return;
    booted = true;
    const capability = data.capability, kind = data.kind as InlineCaptureKind;
    parentPort = event.ports[0]!;
    // This port carries lifecycle metadata only. It never receives commands or secret values.
    parentPort.start();
    const fail = () => { parentPort?.postMessage({ type: 'failed' }); clear(); runtime?.disconnect(); };
    try {
      runtime = connect();
      runtime.onDisconnect.addListener(() => { parentPort?.postMessage({ type: 'close' }); clear(); });
      runtime.onMessage.addListener((message: unknown) => {
        if (closed || !message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'binding-challenge' && 'requestId' in message && typeof message.requestId === 'string'
          && 'nonce' in message && typeof message.nonce === 'string') {
          parentPort?.postMessage({ type: 'binding-challenge', requestId: message.requestId, nonce: message.nonce });
          return;
        }
        if (message.type === 'connected' && !authorized) {
          if (!('ok' in message) || message.ok !== true) { fail(); return; }
          authorized = true;
          onReady({ kind, apiUrl: 'apiUrl' in message && typeof message.apiUrl === 'string' ? message.apiUrl : null,
            send(command) {
              if (!authorized || closed || !runtime || command.type === 'scan' || command.type === 'mute') return Promise.reject(new Error('Capture frame unavailable'));
              const mutation = command.type !== 'get' && command.type !== 'begin-review' && command.type !== 'check';
              if (mutation && (!gesture || Date.now() - gesture.at > 1_500)) return Promise.reject(new Error('Trusted capture action required'));
              const id = String(++requestId);
              return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                try { runtime!.postMessage({ type: 'command', requestId: id, envelope: { channel: INLINE_CAPTURE_REVIEW_CHANNEL, capability, kind, command }, ...(gesture ? { gesture } : {}) }); }
                catch { pending.delete(id); reject(new Error('Capture frame unavailable')); fail(); }
              });
            },
            failed: fail,
            ready: () => { if (!closed) parentPort?.postMessage({ type: 'ready' }); },
            resize: height => { if (!closed && Number.isFinite(height)) parentPort?.postMessage({ type: 'resize', height: Math.ceil(height) }); },
            close,
          });
        } else if (authorized && message.type === 'result' && 'requestId' in message && typeof message.requestId === 'string' && 'result' in message) {
          const request = pending.get(message.requestId);
          pending.delete(message.requestId);
          request?.resolve(message.result as InlineCaptureReviewResult);
        }
      });
      runtime.postMessage({ type: 'connect', capability });
    } catch { fail(); }
  };
  win.addEventListener('message', boot);
  win.addEventListener('click', click, true);
  win.addEventListener('keydown', key, true);
  return () => {
    win.removeEventListener('message', boot); win.removeEventListener('click', click, true); win.removeEventListener('keydown', key, true);
    clear(); runtime?.disconnect(); parentPort?.close();
  };
}
