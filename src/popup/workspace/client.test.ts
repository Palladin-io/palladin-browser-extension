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

it('reuses fresh list pages across navigation, coalesces requests, and expires after one minute', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(async (): Promise<WorkspaceReply> => ({ ok: true, data: { items: [], nextCursor: null } }));
    const client = createWorkspaceClient(send);
    const command = { type: 'workspace/grants' } as const;
    await Promise.all([client.send(command), client.send(command)]);
    await client.send(command);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await client.send(command);
    expect(send).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('isolates filters, Entry scope and separate popup/session clients', async () => {
  const send = vi.fn(async (): Promise<WorkspaceReply> => ({ ok: true, data: { items: [], nextCursor: null } }));
  const client = createWorkspaceClient(send);
  await client.send({ type: 'workspace/grants' });
  await client.send({ type: 'workspace/grants', status: 'pending' });
  await client.send({ type: 'workspace/grants', vaultId: 'vault', entryId: 'entry' });
  await createWorkspaceClient(send).send({ type: 'workspace/grants' });
  expect(send).toHaveBeenCalledTimes(4);
});

it('invalidates grant and audit lists after successful decisions, but preserves Sharing', async () => {
  const send = vi.fn(async (): Promise<WorkspaceReply> => ({ ok: true, data: { items: [], nextCursor: null } }));
  const client = createWorkspaceClient(send);
  for (const type of ['workspace/grants', 'workspace/audit', 'workspace/my-shares'] as const) await client.send({ type });
  const listener = vi.fn();
  const unsubscribe = client.subscribe!(listener);
  await client.send({ type: 'workspace/revoke-grant', vaultId: 'vault', grantId: 'grant' });
  expect(listener).toHaveBeenCalledWith(['workspace/grants', 'workspace/audit']);
  for (const type of ['workspace/grants', 'workspace/audit', 'workspace/my-shares'] as const) await client.send({ type });
  expect(send).toHaveBeenCalledTimes(6);
  unsubscribe();
});

it('invalidates both sharing scopes and Logs after sharing changes', async () => {
  const send = vi.fn(async (): Promise<WorkspaceReply> => ({ ok: true, data: { items: [], nextCursor: null } }));
  const client = createWorkspaceClient(send);
  await client.send({ type: 'workspace/my-shares' });
  await client.send({ type: 'workspace/shares', vaultId: 'vault', entryId: 'entry' });
  await client.send({ type: 'workspace/audit' });
  await client.send({ type: 'workspace/revoke-share', vaultId: 'vault', entryId: 'entry', shareId: 'share' });
  await client.send({ type: 'workspace/my-shares' });
  await client.send({ type: 'workspace/shares', vaultId: 'vault', entryId: 'entry' });
  await client.send({ type: 'workspace/audit' });
  expect(send).toHaveBeenCalledTimes(7);
});

it('does not restore a stale in-flight result after a realtime invalidation', async () => {
  let resolve!: (reply: WorkspaceReply) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValue({ ok: true, data: { items: [], nextCursor: 'fresh' } });
  const client = createWorkspaceClient(send);
  const old = client.send({ type: 'workspace/audit' });
  client.invalidate!(['workspace/audit']);
  await client.send({ type: 'workspace/audit' });
  resolve({ ok: true, data: { items: [], nextCursor: 'stale' } });
  await old;
  expect(await client.send({ type: 'workspace/audit' })).toMatchObject({ nextCursor: 'fresh' });
  expect(send).toHaveBeenCalledTimes(2);
});

it('does not cache failures, revealed fields, reasons or approval previews', async () => {
  const send = vi.fn().mockResolvedValueOnce({ ok: false, code: 'network' })
    .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  const client = createWorkspaceClient(send);
  await expect(client.send({ type: 'workspace/audit' })).rejects.toThrow();
  await client.send({ type: 'workspace/audit' });
  for (let i = 0; i < 2; i++) {
    await client.send({ type: 'workspace/grant-reason', vaultId: 'vault', grantId: 'grant' });
    await client.send({ type: 'workspace/field', vaultId: 'vault', entryId: 'entry', fieldId: 'password' });
  }
  expect(send).toHaveBeenCalledTimes(6);
});
