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
  await Promise.resolve(); expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate' }));
  finish({ status: 'accepted', id: 'old' }); await Promise.resolve(); expect(notice.show).not.toHaveBeenCalled(); capture.stop();
});
