// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { bindCaptureFrame } from './frame-connection';

function fixture() {
  const messages: ((message: unknown) => void)[] = [], disconnected: (() => void)[] = [];
  const runtime = { postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: (fn: (message: unknown) => void) => messages.push(fn), removeListener: vi.fn() }, onDisconnect: { addListener: (fn: () => void) => disconnected.push(fn), removeListener: vi.fn() } };
  const parentPort = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
  const connect = vi.fn(() => runtime as unknown as chrome.runtime.Port);
  const ready = vi.fn(), clear = vi.fn();
  const stop = bindCaptureFrame(window, connect, ready, clear);
  const boot = (source: MessageEventSource | null = window.parent, capability = 'a'.repeat(64)) => window.dispatchEvent(new MessageEvent('message', { source, data: { channel: 'palladin.inline-capture-review.boot.v1', capability, kind: 'secret' }, ports: [parentPort as unknown as MessagePort] }));
  return { runtime, parentPort, connect, ready, clear, boot, stop, receive: (value: unknown) => messages.forEach(fn => fn(value)), disconnect: () => disconnected.forEach(fn => fn()) };
}
afterEach(() => vi.restoreAllMocks());
it('waits for runtime capability authorization before exposing a capture RPC', async () => {
  const f = fixture();
  f.boot(null); f.boot(window.parent, 'bad'); expect(f.connect).not.toHaveBeenCalled();
  f.boot(); expect(f.runtime.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'connect', capability: 'a'.repeat(64) });
  expect(f.ready).not.toHaveBeenCalled();
  f.receive({ type: 'connected', ok: true, apiUrl: 'https://api.example.test' });
  const connection = f.ready.mock.calls[0]![0];
  expect(connection.apiUrl).toBe('https://api.example.test');
  const pending = connection.send({ channel: 'palladin.secret-capture', type: 'get' });
  const sent = f.runtime.postMessage.mock.calls.at(-1)![0];
  expect(sent).toMatchObject({ type: 'command', envelope: { capability: 'a'.repeat(64), kind: 'secret', command: { type: 'get' } } });
  f.receive({ type: 'result', requestId: sent.requestId, result: { status: 'review', candidate: { value: 'synthetic-secret' } } });
  await expect(pending).resolves.toMatchObject({ candidate: { value: 'synthetic-secret' } });
  expect(JSON.stringify(f.parentPort.postMessage.mock.calls)).not.toContain('synthetic-secret');
  f.stop();
});
it('rejects synthetic input as mutation authority and clears on disconnect', async () => {
  const f = fixture(); f.boot(); f.receive({ type: 'connected', ok: true });
  const connection = f.ready.mock.calls[0]![0];
  window.dispatchEvent(new MouseEvent('click', { clientX: 12, clientY: 24 }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(f.clear).not.toHaveBeenCalled(); expect(f.runtime.disconnect).not.toHaveBeenCalled();
  await expect(connection.send({ channel: 'palladin.secret-capture', type: 'dismiss', id: 'candidate' })).rejects.toThrow();
  const pending = connection.send({ channel: 'palladin.secret-capture', type: 'get' });
  f.disconnect(); await expect(pending).rejects.toThrow(); expect(f.clear).toHaveBeenCalled();
  f.stop();
});
it('fails closed after runtime rejects the capability and ignores later boot messages', () => {
  const f = fixture(); f.boot(); f.receive({ type: 'connected', ok: false }); f.boot();
  expect(f.ready).not.toHaveBeenCalled(); expect(f.parentPort.postMessage).toHaveBeenCalledWith({ type: 'failed' });
  expect(f.connect).toHaveBeenCalledTimes(1); f.stop();
});
