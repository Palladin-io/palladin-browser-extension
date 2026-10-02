// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startShareSaveBridge } from './share-save';
import { SHARE_SAVE_CHANNEL } from '../../shared/messaging/share-save';

const id = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

afterEach(() => { window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

describe('isolated share bridge', () => {
  it('forwards only a valid same-origin top-frame request on a share path', async () => {
    window.history.replaceState(null, '', `/share/${id}`);
    const send = vi.fn(async () => ({ channel: SHARE_SAVE_CHANNEL, type: 'response', requestId, status: 'ready' }));
    const stop = startShareSaveBridge(window, send, () => true);
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin,
      data: { channel: SHARE_SAVE_CHANNEL, type: 'status', requestId } }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    stop();
  });

  it('rejects wrong source, origin, path, and malformed payload', () => {
    window.history.replaceState(null, '', `/share/${id}`);
    const send = vi.fn(async () => undefined);
    const stop = startShareSaveBridge(window, send, origin => origin === window.location.origin);
    const valid = { channel: SHARE_SAVE_CHANNEL, type: 'status', requestId };
    window.dispatchEvent(new MessageEvent('message', { source: null, origin: window.location.origin, data: valid }));
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://other.example', data: valid }));
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin,
      data: { ...valid, extra: 'not allowed' } }));
    window.history.replaceState(null, '', '/not-a-share');
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin, data: valid }));
    expect(send).not.toHaveBeenCalled();
    stop();
  });
  it('does not call a failed prepare unavailable when its worker outcome is unknown', async () => {
    window.history.replaceState(null, '', `/share/${id}`);
    const send = vi.fn(async () => { throw new Error('lost worker response'); });
    const post = vi.spyOn(window, 'postMessage');
    const stop = startShareSaveBridge(window, send, () => true);
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: window.location.origin,
      data: { channel: SHARE_SAVE_CHANNEL, type: 'prepare', requestId, snapshot: {
        schema: 'palladin.entry-share.v1', title: 'Synthetic', entryType: 'key',
        fields: [{ id: 'key.value', label: '', type: 'concealed', value: 'synthetic' }],
      } } }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    stop();
  });
});
