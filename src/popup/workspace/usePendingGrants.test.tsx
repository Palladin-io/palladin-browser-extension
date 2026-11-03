// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePendingGrants } from './usePendingGrants';
import { createWorkspaceClient } from './client';

it('invalidates Inbox and Logs immediately on a worker realtime notification', async () => {
  let listener!: (message: unknown) => void;
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener } } });
  try {
    const send = vi.fn().mockResolvedValue({ ok: true, data: { pending: 1 } });
    const client = createWorkspaceClient(send);
    const invalidate = vi.spyOn(client, 'invalidate');
    const { result, unmount } = renderHook(() => usePendingGrants(client));
    await waitFor(() => expect(result.current.badge).toBe('1'));
    act(() => listener({ type: 'workspace/changed' }));
    expect(invalidate).toHaveBeenCalledWith(['workspace/grants', 'workspace/audit']);
    await waitFor(() => expect(result.current.revision).toBe(2));
    unmount();
    expect(removeListener).toHaveBeenCalledWith(listener);
  } finally { vi.unstubAllGlobals(); }
});
