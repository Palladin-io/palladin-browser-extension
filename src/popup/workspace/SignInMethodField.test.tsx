// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceCommand, WorkspaceReply } from '../../shared/workspace/commands';
import { I18nProvider } from '../i18n';
import { createWorkspaceClient } from './client';
import { EntryFields } from './EntryFields';
import type { VaultClient } from '../vault/client';
const vaultId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const methodId = 'custom:AAAAAA11-1111-4111-8111-111111111111';
function setup(methods: unknown[] = [], fails = false) {
 const send = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceReply> => command.type === 'workspace/detail'
  ? { ok: true, data: { fields: [], signIn: { status: 'methods', methods } } as never }
  : fails ? { ok: false, code: 'conflict' } : { ok: true, data: null });
 render(<I18nProvider locale="en"><EntryFields client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} vaultId={vaultId} entryId={entryId} /></I18nProvider>);
 return send;
}
describe('popup sign-in collection', () => {
 it('renders compact same-provider rows and edits/removes the chosen exact ID', async () => {
  const send = setup([{ id: methodId, provider: 'google', account: 'first@test', agentVisible: true },
   { id: 'custom:bbbbbb22-2222-4222-8222-222222222222', provider: 'google', account: 'second@test', agentVisible: false }]);
  expect(await screen.findByText('first@test')).toBeVisible();
  expect(screen.getByText('second@test')).toBeVisible();
  expect(screen.queryByText(/Agents can see/)).toBeNull();
  await userEvent.click(screen.getAllByRole('button', { name: 'Change sign-in method' })[0]!);
  expect(screen.getByRole('checkbox')).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Forget sign-in method' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/sign-in', vaultId, entryId, fieldId: methodId, binding: null, agentVisible: false, locale: 'en' }));
 });
 it('empty section contains heading and plus, then adds a typed optional account', async () => {
  const send = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Remember a sign-in method' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Provider account' }), '  octo  ');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/sign-in', vaultId, entryId, fieldId: null, binding: { provider: 'google', account: 'octo' }, agentVisible: false, locale: 'en' }));
 });
 it('retains the editor when the worker refuses a write', async () => {
  setup([], true);
  await userEvent.click(await screen.findByRole('button', { name: 'Remember a sign-in method' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(screen.getByRole('combobox', { name: 'Provider' })).toBeVisible();
 });
});
