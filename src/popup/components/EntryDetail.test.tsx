// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VaultClient } from '../vault/client';
import { createWorkspaceClient } from '../workspace/client';
import { EntryDetail } from './EntryDetail';

function renderDetail(client: VaultClient) {
  return render(<EntryDetail
    client={client}
    entry={{ id: 'entry-1', vaultId: 'vault-1', vaultName: 'Personal', name: 'Example login', type: 1, urlDomain: 'example.com', updatedAt: '' }}
    workspaceClient={createWorkspaceClient(async () => ({ ok: true, data: { revision: '1', fields: [] } }))}
    onBack={vi.fn()} onGrants={vi.fn()} onLogs={vi.fn()}
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
