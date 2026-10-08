// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GrantsPanel } from './GrantsPanel';
import { createWorkspaceClient } from './client';

afterEach(cleanup);
it.each([true, false])('shows Entry/Vault, the granting Member and an honest authorization date (recorded=%s)', async recorded => {
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/grant-reason'
    ? { reason: 'Run the requested report' }
    : { items: [{ id: 'grant', vaultId: 'vault', entryId: 'entry', agentName: 'Synthetic agent', status: 'active', type: 'granular',
      createdAt: '2026-10-01T10:00:00Z', createdBy: 'member', createdByName: 'Synthetic owner',
      grantedAt: recorded ? '2026-10-05T12:00:00Z' : null, encryptedReason: {}, canRevoke: false }], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[{ id: 'entry', vaultId: 'vault', name: 'Reports', vaultName: 'Work', type: 1, updatedAt: '' }]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic agent/ }));
  await screen.findByText('Run the requested report');
  expect(screen.getByRole('heading', { name: 'Reports' })).toBeTruthy();
  expect(screen.getByText('Work')).toBeTruthy();
  expect(screen.getByText('Synthetic owner')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Encrypted request reason' })).toBeTruthy();
  expect(screen.queryByText('Not recorded for this grant') !== null).toBe(!recorded);
  expect(screen.getByRole('button', { name: 'Refresh' }).textContent).toBe('');
});

it('keeps expiry visible for a pending grant before approval', async () => {
  const grant = { id: 'pending', vaultId: 'vault', entryId: 'entry', agentName: 'Pending agent', status: 'pending', type: 'granular', createdAt: '2026-10-01T10:00:00Z' };
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/review-grant'
    ? { grant, methods: 1, fields: [] }
    : { items: [grant], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Pending agent/ }));
  expect(await screen.findByText('Set when approving')).toBeInTheDocument();
  expect(screen.getByText('Expires')).toBeInTheDocument();
});

it.each([true, false])('exposes active grant revocation only when the API permits it (%s)', async canRevoke => {
  const grant = { id: 'grant', vaultId: 'vault', agentName: 'Active agent', status: 'active', type: 'full', createdAt: '2026-10-01T10:00:00Z', canRevoke };
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/revoke-grant' ? null : { items: [grant], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Active agent/ }));
  const revoke = screen.queryByRole('button', { name: 'Revoke access' });
  expect(Boolean(revoke)).toBe(canRevoke);
  if (revoke) {
    fireEvent.click(revoke);
    await screen.findByText('Select a request to review access.');
    expect(send).toHaveBeenCalledWith({ type: 'workspace/revoke-grant', vaultId: 'vault', grantId: 'grant' });
  }
});

it.each([true, false])('clears inherited loading after a quiet refresh supersedes a pending manual refresh (success=%s)', async success => {
  const page = { ok: true, data: { items: [{ id: 'grant', vaultId: 'vault', agentName: 'Active agent', status: 'active', type: 'full', createdAt: '2026-10-01T10:00:00Z' }], nextCursor: null } };
  let finishManual!: (value: typeof page) => void;
  let finishQuiet!: (value: unknown) => void;
  const send = vi.fn().mockResolvedValueOnce(page)
    .mockImplementationOnce(() => new Promise(resolve => { finishManual = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishQuiet = resolve; }));
  const client = createWorkspaceClient(send);
  const { rerender } = render(<GrantsPanel client={client} revision={0} entries={[]} />);
  await screen.findByRole('button', { name: /Active agent/ });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('button', { name: /Active agent/ })).toBeDisabled();
  rerender(<GrantsPanel client={client} revision={1} entries={[]} />);
  await act(async () => { finishQuiet(success ? page : { ok: false, code: 'network' }); });
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(screen.getByRole('button', { name: /Active agent/ })).toBeEnabled();
  await act(async () => { finishManual({ ok: true, data: { items: [], nextCursor: null } }); });
  expect(screen.getByRole('button', { name: /Active agent/ })).toBeEnabled();
});

it('keeps grant actions disabled while a mutation survives a quiet list refresh', async () => {
  const page = { ok: true, data: { items: [{ id: 'grant', vaultId: 'vault', agentName: 'Active agent', status: 'active', type: 'full', createdAt: '2026-10-01T10:00:00Z', canRevoke: true }], nextCursor: null } };
  let finishRevoke!: (value: unknown) => void;
  const send = vi.fn().mockImplementation(command => command.type === 'workspace/revoke-grant'
    ? new Promise(resolve => { finishRevoke = resolve; }) : Promise.resolve(page));
  const client = createWorkspaceClient(send);
  const { rerender } = render(<GrantsPanel client={client} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Active agent/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
  await act(async () => { rerender(<GrantsPanel client={client} revision={1} entries={[]} />); });
  expect(screen.getByRole('button', { name: 'Revoke access' })).toBeDisabled();
  await act(async () => { finishRevoke({ ok: true, data: null }); });
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});
