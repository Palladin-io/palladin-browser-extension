// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SharingPanel } from './SharingPanel';
import { createWorkspaceClient } from './client';
import type {
  WorkspaceCommand,
  WorkspaceReply,
} from '../../shared/workspace/commands';
import type { VaultClient } from '../vault/client';

it('retries only an unfinished named recipient with the same operation ID', async () => {
  let calls = 0;
  const send = vi.fn(
    async (command: WorkspaceCommand): Promise<WorkspaceReply> => {
      if (command.type === 'workspace/shares')
        return { ok: true, data: { items: [], nextCursor: null } };
      if (command.type === 'workspace/create-share') {
        if (++calls === 2) return { ok: false, code: 'network' };
        return {
          ok: true,
          data: {
            url: 'https://example.test/share/synthetic#v=1',
            shareId: command.operationId,
          },
        };
      }
      return { ok: true, data: null };
    },
  );
  const entry = {
    id: 'entry',
    vaultId: 'vault',
    name: 'Synthetic entry',
    vaultName: 'Personal',
    type: 1 as const,
    updatedAt: '',
  };
  const user = userEvent.setup();
  render(
    <SharingPanel
      client={createWorkspaceClient(send)}
      vaultClient={{ armClipboardClear: vi.fn() } as unknown as VaultClient}
      entries={[entry]}
      initialEntry={entry}
      initialCreate
    />,
  );
  await user.click(screen.getByText('Who can open', { selector: 'summary span' }));
  await user.selectOptions(screen.getByLabelText('Who can open'), 'named');
  await user.type(
    screen.getByLabelText('Recipient email'),
    'one@example.test,two@example.test',
  );
  await user.click(screen.getByRole('button', { name: 'Create link' }));
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  const creations = send.mock.calls.flatMap(([command]) =>
    command.type === 'workspace/create-share' ? [command] : [],
  );
  expect(creations.map((command) => command.recipientEmail)).toEqual([
    'one@example.test',
    'two@example.test',
    'two@example.test',
  ]);
  expect(creations[1]?.operationId).toBe(creations[2]?.operationId);
  expect(await screen.findAllByLabelText('Sharing link')).toHaveLength(2);
});


it('opens the create form without requesting existing shares', async () => {
  const send = vi.fn(async (): Promise<WorkspaceReply> => ({ ok: false, code: 'network' }));
  const entry = { id: 'entry', vaultId: 'vault', name: 'Synthetic entry', vaultName: 'Personal', type: 1 as const, updatedAt: '' };
  render(<SharingPanel client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} entries={[entry]} initialEntry={entry} initialCreate embedded />);
  expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

for (const clipboardWorks of [true, false]) {
  it(`keeps a created link available when automatic copy ${clipboardWorks ? 'succeeds' : 'fails'}`, async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    if (!clipboardWorks) write.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    const armClipboardClear = vi.fn(async () => {});
    const send = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceReply> => command.type === 'workspace/create-share'
      ? { ok: true, data: { url: 'https://example.test/share/synthetic#v=1', shareId: command.operationId } }
      : { ok: true, data: null });
    const entry = { id: 'entry', vaultId: 'vault', name: 'Synthetic entry', vaultName: 'Personal', type: 1 as const, updatedAt: '' };
    render(<SharingPanel client={createWorkspaceClient(send)} vaultClient={{ armClipboardClear } as unknown as VaultClient} entries={[entry]} initialEntry={entry} initialCreate embedded />);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByLabelText('Sharing link');
    await waitFor(() => expect(write).toHaveBeenCalledWith('https://example.test/share/synthetic#v=1'));
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    if (clipboardWorks) await waitFor(() => expect(armClipboardClear).toHaveBeenCalledOnce());
    else {
      expect(await screen.findByRole('status')).toHaveTextContent('Link created');
      await user.click(screen.getByRole('button', { name: 'Copy link' }));
      await waitFor(() => expect(armClipboardClear).toHaveBeenCalledOnce());
      expect(send.mock.calls.filter(([command]) => command.type === 'workspace/create-share')).toHaveLength(1);
    }
    write.mockRestore();
  });
}
