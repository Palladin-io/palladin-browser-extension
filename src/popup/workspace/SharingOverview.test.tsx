// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SharingOverview } from './SharingOverview';
import { createWorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const entries = Array.from({ length: 35 }, (_, i) => ({ id: `entry-${i}`, vaultId: 'vault', name: 'Synthetic', vaultName: 'Personal', type: 1 as const, updatedAt: '' }));
it('uses one aggregate request regardless of the number of Entries and retries only explicitly', async () => {
  const send = vi.fn().mockResolvedValue({ ok: false, code: 'network', httpStatus: 400 });
  render(<SharingOverview client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} entries={entries} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'workspace/my-shares' });
  expect(screen.getByRole('alert').textContent).toContain('HTTP 400');
  send.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(send).toHaveBeenCalledTimes(2);
});
it('does not refetch when Entry projections or membership change', async () => {
  const send = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  const client = createWorkspaceClient(send), vaultClient = {} as VaultClient;
  const view = render(<SharingOverview client={client} vaultClient={vaultClient} entries={entries} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false));
  view.rerender(<SharingOverview client={client} vaultClient={vaultClient} entries={entries.slice(1).map(entry => ({ ...entry }))} />);
  expect(send).toHaveBeenCalledTimes(1);
});
it('loads one next page at the scroll sentinel with no duplicate request or Load next button', async () => {
  let intersect!: () => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (records: { isIntersecting: boolean }[]) => void) { intersect = () => callback([{ isIntersecting: true }]); }
    observe() {} disconnect() {}
  });
  const send = vi.fn().mockResolvedValueOnce({ ok: true, data: { items: [], nextCursor: 'next' } })
    .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
  render(<SharingOverview client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} entries={entries} />);
  await waitFor(() => expect(intersect).toBeDefined());
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /Load next/ })).toBeNull();
  act(() => { intersect(); intersect(); });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send).toHaveBeenLastCalledWith({ type: 'workspace/my-shares', cursor: 'next' });
});

const share = { shareId: 'share-1', status: 'active', createdAt: '2026-10-07', expiresAt: '2026-10-08', maximumReceipts: null, deliveryCount: 0, firstDeliveredAt: null, lastDeliveredAt: null, firstConfirmedAt: null, notifyOnFirstReceipt: false, recipientMode: 'anyone', recipientEmail: null, protection: 'none', sourceChanged: false };
function management() {
  const send = vi.fn().mockImplementation(async (command) => command.type === 'workspace/my-shares'
    ? { ok: true, data: { items: [{ vaultId: 'vault', entryId: 'entry-0', share }], nextCursor: null } }
    : { ok: true, data: null });
  render(<SharingOverview client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} entries={entries} />);
  return send;
}
it('edits the selected link directly without another list request', async () => {
  const send = management();
  fireEvent.click(await screen.findByRole('button', { name: 'Change protection' }));
  expect(screen.getByRole('button', { name: 'Open web panel' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save protection' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/protect-share', vaultId: 'vault', entryId: 'entry-0', shareId: 'share-1', protection: 'none', protectionSecret: null }));
  await screen.findByRole('button', { name: 'Change protection' });
  expect(send.mock.calls.some(([command]) => command.type === 'workspace/shares')).toBe(false);
});
it('requires confirmation to revoke and preserves retry after a failed mutation', async () => {
  const send = management();
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  send.mockResolvedValueOnce({ ok: false, code: 'network' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!);
  await screen.findByRole('alert');
  fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!);
  await screen.findByText('Revoked');
  expect(send).toHaveBeenLastCalledWith({ type: 'workspace/revoke-share', vaultId: 'vault', entryId: 'entry-0', shareId: 'share-1' });
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});
