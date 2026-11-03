// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VaultClient } from '../vault/client';
import { createWorkspaceClient } from '../workspace/client';
import { EntryDetail } from './EntryDetail';

function renderDetail(client: VaultClient, onShares = vi.fn()) {
  return render(<EntryDetail
    client={client}
    entry={{ id: 'entry-1', vaultId: 'vault-1', vaultName: 'Personal', name: 'Example login', type: 1, urlDomain: 'example.com', updatedAt: '' }}
    workspaceClient={createWorkspaceClient(async command => ({ ok: true, data: command.type === 'workspace/audit' || command.type === 'workspace/members' ? { items: [], nextCursor: null } : { revision: '1', fields: [] } }))}
    onBack={vi.fn()} onGrants={vi.fn()} onLogs={vi.fn()} onShares={onShares}
  />);
}

describe("EntryDetail deletion", () => {
  it("requires confirmation, permits cancellation and prevents duplicate deletion", async () => {
    let finish!: () => void;
    const deleteEntry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const client = { deleteEntry, credentialUsername: vi.fn(async () => ""), totp: vi.fn(async () => null) } as unknown as VaultClient;
    const user = userEvent.setup();
    renderDetail(client);
    await user.click(screen.getByRole("button", { name: "Delete Entry" }));
    expect(deleteEntry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteEntry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete Entry" }));
    await user.click(screen.getByRole("button", { name: "Move to Recently Deleted" }));
    expect(deleteEntry).toHaveBeenCalledWith("vault-1", "entry-1");
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    finish();
    expect(await screen.findByRole("status")).toHaveTextContent("Entry moved to Recently Deleted");
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("keeps the Entry available when deletion fails", async () => {
    const client = { deleteEntry: vi.fn(async () => { throw new Error("unavailable"); }), credentialUsername: vi.fn(async () => ""), totp: vi.fn(async () => null) } as unknown as VaultClient;
    const user = userEvent.setup();
    renderDetail(client);
    await user.click(screen.getByRole("button", { name: "Delete Entry" }));
    await user.click(screen.getByRole("button", { name: "Move to Recently Deleted" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't delete the Entry");
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });
});

it('keeps Share creation separate from the shared-link list', async () => {
  const onShares = vi.fn();
  const client = { credentialUsername: vi.fn(async () => ''), totp: vi.fn(async () => null) } as unknown as VaultClient;
  const user = userEvent.setup();
  renderDetail(client, onShares);
  await user.click(screen.getByRole('button', { name: 'Sharing' }));
  expect(onShares).toHaveBeenCalledOnce();
  await user.click(screen.getAllByRole('button', { name: 'Share' }).at(-1)!);
  expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  expect(onShares).toHaveBeenCalledOnce();
});

it('loads recent activity for the selected Entry and opens its Logs', async () => {
  const onLogs = vi.fn();
  const send = vi.fn(async (command: { type: string }) => ({ ok: true as const, data: command.type === 'workspace/audit'
    ? { items: [], nextCursor: 'older' } : command.type === 'workspace/members' ? { items: [] } : { revision: '1', fields: [] } }));
  render(<EntryDetail client={{ credentialUsername: vi.fn(async () => ''), totp: vi.fn(async () => null) } as unknown as VaultClient}
    entry={{ id: 'entry-1', vaultId: 'vault-1', vaultName: 'Personal', name: 'Example', type: 1, updatedAt: '' }}
    workspaceClient={createWorkspaceClient(send)} onBack={vi.fn()} onGrants={vi.fn()} onLogs={onLogs} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
  expect(send).toHaveBeenCalledWith({ type: 'workspace/audit', entryId: 'entry-1', vaultId: 'vault-1' });
  expect(onLogs).toHaveBeenCalledOnce();
});
