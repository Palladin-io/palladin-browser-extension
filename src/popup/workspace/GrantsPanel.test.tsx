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
  client.invalidate!(['workspace/grants'], false);
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

it('approves with the selected quick duration and only the requested methods', async () => {
  const now = Date.now();
  const grant = { id: 'pending', vaultId: 'vault', entryId: 'entry', agentName: 'Pending agent', status: 'pending', type: 'granular', createdAt: '2026-10-01T10:00:00Z' };
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/review-grant'
    ? { grant, entryId: 'entry', revision: 4, methods: 4, fields: [] }
    : command.type === 'workspace/approve-grant' ? null : { items: [grant], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Pending agent/ }));
  fireEvent.click(await screen.findByRole('button', { name: '2 h' }));
  expect(screen.getByRole('button', { name: '2 h' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Approve access' }));
  await screen.findByText('Select a request to review access.');
  const command = send.mock.calls.find(([command]) => command.type === 'workspace/approve-grant')![0];
  expect(command).toMatchObject({ methods: 4, revision: 4, selection: 'all', fields: [], policy: { kind: 'time' } });
  expect(Date.parse(command.policy.expiresAt) - now).toBeGreaterThanOrEqual(120 * 60_000);
  expect(Date.parse(command.policy.expiresAt) - now).toBeLessThan(120 * 60_000 + 5000);
});

it('denies with the optional reason without submitting the approval form', async () => {
  const grant = { id: 'pending', vaultId: 'vault', entryId: 'entry', agentName: 'Pending agent', status: 'pending', type: 'granular', createdAt: '2026-10-01T10:00:00Z' };
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/review-grant'
    ? { grant, entryId: 'entry', revision: 4, methods: 4, fields: [] }
    : command.type === 'workspace/deny' ? null : { items: [grant], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Pending agent/ }));
  await screen.findByRole('button', { name: '2 h' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not needed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await screen.findByText('Select a request to review access.');
  expect(send).toHaveBeenCalledWith({ type: 'workspace/deny', vaultId: 'vault', grantId: 'pending', reason: 'Not needed' });
  expect(send.mock.calls.some(([command]) => command.type === 'workspace/approve-grant')).toBe(false);
});

it('merges selected server status pages and preserves each pagination cursor', async () => {
  const grant = (id: string, status: string, day: number) => ({ id, vaultId: 'vault', agentName: id, status, type: 'full', createdAt: `2026-10-${day}T10:00:00Z` });
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.status === 'active'
    ? { items: [grant(command.cursor ? 'older-active' : 'active-agent', 'active', command.cursor ? 11 : 20)], nextCursor: command.cursor ? null : 'active-next' }
    : command.status === 'expired' ? { items: [grant('expired-agent', 'expired', 15)], nextCursor: null }
    : { items: [], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'Grant status' }));
  fireEvent.click(screen.getByRole('option', { name: 'Active' }));
  await screen.findByRole('button', { name: /active-agent/ });
  fireEvent.click(screen.getByRole('option', { name: 'Expired' }));
  await screen.findByRole('button', { name: /expired-agent/ });
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('option', { name: 'Expired' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('button', { name: /older-active/ });
  expect(send).toHaveBeenLastCalledWith({ type: 'workspace/grants', status: 'active', cursor: 'active-next' });
  expect(screen.getByRole('button', { name: /expired-agent/ })).toBeInTheDocument();
});

it('discards old pagination while a replacement filter is loading', async () => {
  let resolveFiltered!: (result: unknown) => void;
  const send = vi.fn().mockResolvedValueOnce({ ok: true, data: { items: [{ id: 'old', vaultId: 'vault', agentName: 'Old agent', status: 'expired', type: 'full', createdAt: '2026-10-20' }], nextCursor: 'old-page' } })
    .mockImplementation(() => new Promise(resolve => { resolveFiltered = resolve; }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  await screen.findByRole('button', { name: 'Load more' });
  fireEvent.click(screen.getByRole('combobox', { name: 'Grant status' }));
  fireEvent.click(screen.getByRole('option', { name: 'Active' }));
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Old agent/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  await act(async () => resolveFiltered({ ok: true, data: { items: [], nextCursor: null } }));
  expect(send).toHaveBeenLastCalledWith({ type: 'workspace/grants', status: 'active' });
  expect(send.mock.calls.some(([command]) => command.cursor === 'old-page')).toBe(false);
});

it('preselects requested operations and keeps unrequested ones disabled in a collapsed section', async () => {
  const grant = { id: 'pending', vaultId: 'vault', entryId: 'entry', agentName: 'Pending agent', status: 'pending', type: 'granular', createdAt: '2026-10-01T10:00:00Z' };
  const send = vi.fn().mockImplementation(async command => ({ ok: true, data: command.type === 'workspace/review-grant'
    ? { grant, entryId: 'entry', revision: 4, methods: 4, fields: [] }
    : { items: [grant], nextCursor: null } }));
  render(<GrantsPanel client={createWorkspaceClient(send)} revision={0} entries={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Pending agent/ }));
  expect(await screen.findByRole('checkbox', { name: /Inject/ })).toBeChecked();
  const other = screen.getByText('Other operations').closest('details')!;
  expect(other.open).toBe(false);
  const hiddenOptions = other.querySelectorAll('input');
  expect(hiddenOptions).toHaveLength(2);
  hiddenOptions.forEach(input => { expect(input).toBeDisabled(); expect(input).not.toBeChecked(); });
  fireEvent.click(screen.getByText('Other operations'));
  expect(other.open).toBe(true);
  expect(screen.getByRole('checkbox', { name: /Get -/ })).toBeDisabled();
});

it('reuses the list when returning to Inbox and refreshes visible rows after invalidation', async () => {
  const grant = { id: 'grant', vaultId: 'vault', agentName: 'Cached agent', status: 'active', type: 'full', createdAt: '2026-10-01T10:00:00Z' };
  const send = vi.fn().mockResolvedValue({ ok: true, data: { items: [grant], nextCursor: null } });
  const client = createWorkspaceClient(send);
  const first = render(<GrantsPanel client={client} revision={0} entries={[]} />);
  await screen.findByRole('button', { name: /Cached agent/ });
  first.unmount();
  render(<GrantsPanel client={client} revision={0} entries={[]} />);
  await screen.findByRole('button', { name: /Cached agent/ });
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValue({ ok: true, data: { items: [{ ...grant, agentName: 'Updated agent' }], nextCursor: null } });
  act(() => client.invalidate!(['workspace/grants', 'workspace/audit']));
  await screen.findByRole('button', { name: /Updated agent/ });
  expect(send).toHaveBeenCalledTimes(2);
});
