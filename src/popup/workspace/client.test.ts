import { expect, it, vi } from 'vitest';
import { createWorkspaceClient } from './client';
import type { WorkspaceReply } from '../../shared/workspace/commands';
it('shares one memory directory and performs at most one whole-directory repair for missing actors', async () => {
  const send = vi.fn(async (): Promise<WorkspaceReply> => ({
    ok: true,
    data: { items: [{ userId: 'one', displayName: 'Synthetic one' }] },
  }));
  const client = createWorkspaceClient(send);
  await Promise.all([client.members(['one']), client.members(['one'])]);
  expect(send).toHaveBeenCalledTimes(1);
  await client.members(['missing']);
  await client.members(['another']);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith({ type: 'workspace/members' });
});

it('sends workspace commands directly without a build handshake', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: { pending: 2 } });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  try {
    await expect(createWorkspaceClient().send({ type: 'workspace/grant-summary' })).resolves.toEqual({ pending: 2 });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'workspace/grant-summary' });
  } finally { vi.unstubAllGlobals(); }
});

it('preserves operation errors and allows retry after a transient worker failure', async () => {
  const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Worker disconnected'))
    .mockResolvedValueOnce({ ok: false, code: 'locked' })
    .mockResolvedValueOnce({ ok: true, data: { pending: 0 } });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  try {
    const client = createWorkspaceClient();
    await expect(client.send({ type: 'workspace/grant-summary' })).rejects.toMatchObject({ code: 'worker' });
    await expect(client.send({ type: 'workspace/grant-summary' })).rejects.toMatchObject({ code: 'locked' });
    await expect(client.send({ type: 'workspace/grant-summary' })).resolves.toEqual({ pending: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(3);
  } finally { vi.unstubAllGlobals(); }
});
