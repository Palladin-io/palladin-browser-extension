// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceCommand, WorkspaceReply } from '../../shared/workspace/commands';
import { I18nProvider } from '../i18n';
import { createWorkspaceClient } from './client';
import { EntryFields } from './EntryFields';
import type { VaultClient } from '../vault/client';

const vaultId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';

function setup(signIn: unknown, reply: (command: WorkspaceCommand) => WorkspaceReply = () => ({ ok: true, data: null })) {
  const send = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceReply> => command.type === 'workspace/detail'
    ? { ok: true, data: { fields: [], signIn } as never }
    : reply(command));
  render(<I18nProvider locale="en"><EntryFields client={createWorkspaceClient(send)} vaultClient={{} as VaultClient}
    vaultId={vaultId} entryId={entryId} /></I18nProvider>);
  return send;
}

describe('sign-in method in the popup', () => {
  it('shows a remembered provider account and removes it only on an explicit action', async () => {
    const send = setup({ status: 'recognized', provider: 'google', account: 'work@corp.com' });
    expect(await screen.findByText('Google · work@corp.com')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Forget sign-in method' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'workspace/sign-in', vaultId, entryId, binding: null, locale: 'en' });
    expect(await screen.findByText('Password or not remembered')).toBeVisible();
  });

  it('adds a provider with a trimmed optional account', async () => {
    const send = setup({ status: 'absent' });
    await userEvent.click(await screen.findByRole('button', { name: 'Remember a sign-in method' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'github');
    await userEvent.type(screen.getByRole('textbox', { name: 'Provider account' }), '  octo  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'workspace/sign-in', vaultId, entryId,
      binding: { provider: 'github', account: 'octo' }, locale: 'en' });
    expect(await screen.findByText('GitHub · octo')).toBeVisible();
  });

  it('keeps the editor open with an error when saving fails and blocks too-long accounts', async () => {
    setup({ status: 'absent' }, () => ({ ok: false, code: 'conflict' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remember a sign-in method' }));
    const input = screen.getByRole('textbox', { name: 'Provider account' });
    await userEvent.type(input, 'a'.repeat(257));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the sign-in method');
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeVisible();
  });

  it('does not offer editing for unrecognized data but allows forgetting it, and hides for other Entry types', async () => {
    setup({ status: 'unrecognized' });
    expect(await screen.findByText(/cannot be shown here/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Change sign-in method|Remember a sign-in method/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget sign-in method' })).toBeVisible();
  });

  it('renders nothing for non-Credential entries', async () => {
    setup({ status: 'unsupported' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Sign-in method')).toBeNull();
  });
});
