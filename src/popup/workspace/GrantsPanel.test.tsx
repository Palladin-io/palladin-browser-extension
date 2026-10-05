// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
