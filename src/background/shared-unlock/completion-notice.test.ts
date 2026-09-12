import { describe, expect, it, vi } from 'vitest';
import { isBridgeMessage } from '../../shared/messaging';
import { SHARED_UNLOCK_NOTICE_PORT, isSharedUnlockNotice, isSharedUnlockNoticeVisibility } from '../../shared/messaging/shared-unlock-notice';
import { SharedUnlockCompletionNotice } from './completion-notice';

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return { addListener: (fn: T) => { listeners.add(fn); }, removeListener: (fn: T) => { listeners.delete(fn); }, listeners };
}
const id = 'a'.repeat(32), origin = `chrome-extension://${id}/`;
function port(path = 'src/popup/index.html') {
  const onMessage = event<(raw: unknown) => void>(), onDisconnect = event<() => void>();
  return { name: SHARED_UNLOCK_NOTICE_PORT, sender: { id, url: origin + path },
    onMessage, onDisconnect, postMessage: vi.fn(), disconnect: vi.fn(),
    visible: (visible: boolean) => { for (const fn of onMessage.listeners) fn({ type: 'visibility', visible }); },
    close: () => { for (const fn of onDisconnect.listeners) fn(); } };
}

describe('worker-owned shared unlock completion presentation', () => {
  it('sends one value-free result to only one visible surface, without replay on new open', () => {
    const notices = new SharedUnlockCompletionNotice(), popup = port(), panel = port('src/side-panel/index.html');
    notices.register(popup, id, origin); notices.register(panel, id, origin);
    popup.visible(true); panel.visible(true); notices.completed();
    expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'completed', occurredAt: expect.any(Number) });
    expect(panel.postMessage).not.toHaveBeenCalled();
    popup.close();
    const reopened = port(); notices.register(reopened, id, origin); reopened.visible(true);
    expect(reopened.postMessage).not.toHaveBeenCalled();
    notices.completed();
    expect(panel.postMessage).toHaveBeenCalledOnce();
    expect(reopened.postMessage).not.toHaveBeenCalled();
  });
  it('does not retain a completion when no visible surface exists', () => {
    const notices = new SharedUnlockCompletionNotice(), popup = port();
    notices.register(popup, id, origin); notices.completed(); popup.visible(true);
    expect(popup.postMessage).not.toHaveBeenCalled();
    notices.completed(); expect(popup.postMessage).toHaveBeenCalledOnce();
  });
  it('does not reroute ambiguous failed delivery to the second visible surface', () => {
    const notices = new SharedUnlockCompletionNotice(), popup = port(), panel = port('src/side-panel/index.html');
    notices.register(popup, id, origin); notices.register(panel, id, origin); popup.visible(true); panel.visible(true);
    popup.postMessage.mockImplementation(() => { throw new Error('closed'); });
    notices.completed(); expect(panel.postMessage).not.toHaveBeenCalled();
  });
  it('rejects content, foreign and non-surface senders including forged suffixes', () => {
    const notices = new SharedUnlockCompletionNotice();
    for (const sender of [{ id, url: 'https://example.test', tab: {} }, { id: 'foreign', url: origin + 'src/popup/index.html' },
      { id, url: origin + 'src/offscreen/index.html' }, { id, url: origin + 'src/popup/index.html?fake' }]) {
      const p = { ...port(), sender }; notices.register(p, id, origin); expect(p.disconnect).toHaveBeenCalledOnce();
    }
  });
  it('bounds registrations and removes all listeners on disconnect or malformed input', () => {
    const notices = new SharedUnlockCompletionNotice(), ports = Array.from({ length: 33 }, () => port());
    for (const p of ports) notices.register(p, id, origin);
    expect(ports[32].disconnect).toHaveBeenCalledOnce();
    ports[0].close(); expect(ports[0].onMessage.listeners.size).toBe(0); expect(ports[0].onDisconnect.listeners.size).toBe(0);
    for (const fn of ports[1].onMessage.listeners) fn({ type: 'completed', occurredAt: Date.now() });
    expect(ports[1].disconnect).toHaveBeenCalledOnce(); expect(ports[1].onMessage.listeners.size).toBe(0);
  });
  it('clears all surfaces without publishing success, and restart has no retained result', () => {
    const notices = new SharedUnlockCompletionNotice(), popup = port(); notices.register(popup, id, origin); popup.visible(true);
    notices.clear(); expect(popup.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'clear' });
    const restart = new SharedUnlockCompletionNotice(); restart.completed();
    expect(popup.postMessage).toHaveBeenCalledOnce();
  });
  it('keeps strict private framing outside the page bridge', () => {
    for (const raw of [{ type: 'completed', occurredAt: 1 }, { type: 'clear' }, { type: 'visibility', visible: true }]) expect(isBridgeMessage(raw)).toBe(false);
    expect(isSharedUnlockNotice({ type: 'completed', occurredAt: 1 })).toBe(true);
    for (const raw of [{ type: 'completed', occurredAt: NaN }, { type: 'completed', occurredAt: 1, operationId: 'forged' }, { type: 'clear', extra: true }]) expect(isSharedUnlockNotice(raw)).toBe(false);
    expect(isSharedUnlockNoticeVisibility({ type: 'visibility', visible: true })).toBe(true);
    expect(isSharedUnlockNoticeVisibility({ type: 'visibility', visible: true, session: 'forged' })).toBe(false);
  });
});
