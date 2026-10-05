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

it('rejects a stale worker before sending an operation', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ ok: false, code: 'invalid' });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  try {
    const client = createWorkspaceClient();
    await expect(client.send({ type: 'workspace/grant-summary' })).rejects.toMatchObject({ code: 'reload' });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'workspace/build' });
  } finally { vi.unstubAllGlobals(); }
});
