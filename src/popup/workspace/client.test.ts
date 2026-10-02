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
