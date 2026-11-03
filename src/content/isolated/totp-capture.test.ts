// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { startTotpCapture } from './totp-capture';
const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP';
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('observes a discovered setup and sends no values to the notice', async () => {
  vi.useFakeTimers(); const send = vi.fn(async () => ({ status: 'accepted', id: 'candidate' }));
  const capture = startTotpCapture(document, 'document', { send, detect: () => [uri], notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() } });
  await vi.advanceTimersByTimeAsync(500);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'observe', uri }));
  capture.stop();
});
it('refuses to choose between multiple distinct setup configurations', async () => {
  vi.useFakeTimers(); const send = vi.fn(async () => ({ status: 'accepted', id: 'candidate' }));
  const capture = startTotpCapture(document, 'document', { send, detect: () => [uri, uri.replace('JBSWY3DPEHPK3PXP', 'KRSXG5DSNFXGOIDB')], notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() } });
  expect(await capture.scan()).toBe('ambiguous');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate' }));
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'observe' })); capture.stop();
});
it('invalidates an in-flight observation as soon as the rendered setup changes', async () => {
  vi.useFakeTimers(); let finish!: (result: { status: 'accepted'; id: string }) => void;
  const send = vi.fn((command: { type: string }) => command.type === 'observe'
    ? new Promise<{ status: 'accepted'; id: string }>(resolve => { finish = resolve; }) : Promise.resolve({ status: 'stale' as const }));
  const notice = { show: vi.fn(), hide: vi.fn(), stop: vi.fn() };
  const capture = startTotpCapture(document, 'document', { send, detect: () => [uri], notice });
  await vi.advanceTimersByTimeAsync(350); document.body.append(document.createElement('img'));
  await Promise.resolve(); expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'advance' }));
  finish({ status: 'accepted', id: 'old' }); await Promise.resolve(); expect(notice.show).not.toHaveBeenCalled(); capture.stop();
});
it('treats equivalent link and QR URIs as one setup', async () => {
  const equivalent = 'otpauth://totp/Example%3Aalice?digits=6&period=30&secret=JBSWY3DPEHPK3PXP';
  const send = vi.fn(async () => ({ status: 'accepted', id: 'candidate' }));
  const capture = startTotpCapture(document, 'document', { send, detect: () => [uri, equivalent], notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() } });
  expect(await capture.scan()).toBe('found');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'observe' })); capture.stop();
});
it('keeps the pending proposal when unrelated body content changes', async () => {
  vi.useFakeTimers(); document.body.innerHTML = `<a href="${uri}">setup</a>`;
  const send = vi.fn(async () => ({ status: 'accepted', id: 'candidate' }));
  const capture = startTotpCapture(document, 'document', { send, notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() } });
  await vi.advanceTimersByTimeAsync(400); send.mockClear();
  document.body.append(document.createElement('span')); await vi.advanceTimersByTimeAsync(400);
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate' })); capture.stop();
});
it.each(['class', 'aria-hidden'])('rescans when an ancestor changes %s visibility', async attribute => {
  vi.useFakeTimers(); document.body.innerHTML = `<div><a href="${uri}">setup</a></div>`;
  const send = vi.fn(async () => ({ status: 'accepted', id: 'candidate' }));
  const capture = startTotpCapture(document, 'document', { send, notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() } });
  await vi.advanceTimersByTimeAsync(400); send.mockClear();
  const parent = document.querySelector('div')!;
  if (attribute === 'class') { const style = document.createElement('style'); style.textContent = '.concealed { display:none }'; document.head.append(style); parent.className = 'concealed'; }
  else parent.setAttribute('aria-hidden', 'true');
  await vi.advanceTimersByTimeAsync(400);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate' })); capture.stop();
});
it('native cancel suppresses unchanged canvas polls, while manual retry and changed setup remain available', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<canvas width="64" height="64"></canvas>';
  const { TotpCaptureCoordinator } = await import('../../background/capture/totp-coordinator');
  const source = { tabId: 1, frameId: 0, browserDocumentId: 'browser', topDocumentId: 'browser', documentId: 'document', url: 'https://example.com/setup' };
  const coordinator = new TotpCaptureCoordinator({ session: async () => ({ profileId: 'user', generation: 1, unlocked: true }),
    current: async () => true, sourceMatches: async () => true, activeTabId: async () => 1, choices: async () => [], save: async () => ({}) });
  let observed = uri;
  const capture = startTotpCapture(document, 'document', { detect: () => [observed], notice: { show: vi.fn(), hide: vi.fn(), stop: vi.fn() },
    send: command => command.type === 'observe' ? coordinator.observe(command.uri, source, () => true, command.manual) : Promise.resolve({ status: 'dismissed' }) });
  await vi.advanceTimersByTimeAsync(400); const first = await coordinator.review(); if (first.status !== 'ready') throw Error('missing');
  await coordinator.dismiss(first.id); await vi.advanceTimersByTimeAsync(5_000);
  expect(await coordinator.review()).toEqual({ status: 'empty' });
  expect(await capture.scan()).toBe('found'); const retry = await coordinator.review(); if (retry.status !== 'ready') throw Error('missing retry');
  expect(retry.id).not.toBe(first.id); await coordinator.dismiss(retry.id);
  observed = uri.replace('JBSWY3DPEHPK3PXP', 'KRSXG5DSNFXGOIDB'); await vi.advanceTimersByTimeAsync(5_000);
  const changed = await coordinator.review(); expect(changed.status).toBe('ready');
  capture.stop(); coordinator.clear();
});
