// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuditPanel } from './AuditPanel';
import { createWorkspaceClient } from './client';
import type { WorkspaceCommand } from '../../shared/workspace/commands';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('renders translated lifecycle events and compact context chips with resolved actor names', async () => {
  const client = createWorkspaceClient(vi.fn(async (command: WorkspaceCommand) => command.type === 'workspace/members'
    ? { ok: true as const, data: { items: [{ userId: 'user', displayName: 'Synthetic member' }] } }
    : { ok: true as const, data: { items: [{ id: 'event', eventType: 'vault.created', actorType: 'user', userId: 'user', vaultId: 'vault', entryId: null, metadata: {}, createdAt: '2026-10-05T10:00:00Z' }], nextCursor: null } }));
  const { container } = render(<AuditPanel client={client} entries={[{ id: 'entry', vaultId: 'vault', vaultName: 'Personal', name: 'Example', type: 1, updatedAt: '' }]} />);
  await screen.findByText('Synthetic member');
  expect(container.querySelector('.audit-type')?.textContent).toBe('Vault Created');
  expect(container.querySelector('.audit-chips')?.textContent).toContain('Personal');
  expect(container.querySelector('.audit-event')?.textContent).not.toContain('vault.created');
});

it('loads the next cursor at the scroll sentinel without duplicate requests or a Load more button', async () => {
  let intersect!: () => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (records: { isIntersecting: boolean }[]) => void) { intersect = () => callback([{ isIntersecting: true }]); }
    observe() {} disconnect() {}
  });
  let page = 0;
  const send = vi.fn(async (command: WorkspaceCommand) => command.type === 'workspace/members'
    ? { ok: true as const, data: { items: [] } }
    : { ok: true as const, data: { items: [], nextCursor: ++page === 1 ? 'next' : null } });
  render(<AuditPanel client={createWorkspaceClient(send)} entries={[]} />);
  await waitFor(() => expect(intersect).toBeDefined());
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  act(() => { intersect(); intersect(); });
  await waitFor(() => expect(send.mock.calls.filter(([command]) => command.type === 'workspace/audit')).toHaveLength(2));
  expect(send).toHaveBeenCalledWith({ type: 'workspace/audit', cursor: 'next' });
});

it('uses server-resolved agent names instead of displaying their IDs', async () => {
  const client = createWorkspaceClient(vi.fn(async (command: WorkspaceCommand) => command.type === 'workspace/members'
    ? { ok: true as const, data: { items: [] } }
    : { ok: true as const, data: { items: [{ id: 'event', eventType: 'grant.requested', actorType: 'agent', agentId: 'opaque-agent-id', agentName: 'Synthetic agent', metadata: {}, createdAt: '2026-10-05T10:00:00Z' }], nextCursor: null } }));
  render(<AuditPanel client={client} entries={[]} />);
  await screen.findByText('Synthetic agent');
  expect(screen.queryByText('opaque-agent-id')).toBeNull();
});
