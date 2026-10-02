// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { EntryFields } from './EntryFields';
import { createWorkspaceClient } from './client';
import type {
  WorkspaceCommand,
  WorkspaceReply,
} from '../../shared/workspace/commands';
import type { VaultClient } from '../vault/client';

it('does not copy a delayed secret after the Entry view is closed', async () => {
  let finish!: (reply: WorkspaceReply) => void;
  const send = vi.fn(
    async (command: WorkspaceCommand): Promise<WorkspaceReply> =>
      command.type === 'workspace/detail'
        ? {
            ok: true,
            data: {
              revision: '1',
              fields: [
                {
                  id: 'credential.password',
                  label: '',
                  type: 'concealed',
                  value: null,
                },
              ],
            },
          }
        : new Promise((resolve) => {
            finish = resolve;
          }),
  );
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const view = render(
    <EntryFields
      client={createWorkspaceClient(send)}
      vaultClient={{ armClipboardClear: vi.fn() } as unknown as VaultClient}
      vaultId="vault"
      entryId="entry"
    />,
  );
  await user.click(
    await screen.findByRole('button', { name: 'Copy password' }),
  );
  view.unmount();
  await act(async () =>
    finish({ ok: true, data: { value: 'synthetic-only' } }),
  );
  expect(copy).not.toHaveBeenCalled();
});
