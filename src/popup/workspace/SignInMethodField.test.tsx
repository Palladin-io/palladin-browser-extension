// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCommand, WorkspaceReply } from '../../shared/workspace/commands';
import { I18nProvider } from '../i18n';
import { createWorkspaceClient } from './client';
import { EntryFields } from './EntryFields';
import type { VaultClient } from '../vault/client';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); }; });
vi.mock('../../shared/config/contact', () => ({ contactEmail: 'contact@example.test' }));
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
 it('scrolls providers without changing the method and selects with the keyboard', async () => {
  const send = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
  const rail = screen.getByRole('group', { name: 'Provider' });
  rail.scrollBy = vi.fn();
  await userEvent.click(screen.getByRole('button', { name: 'Next providers' }));
  expect(rail.scrollBy).toHaveBeenCalled();
  fireEvent.scroll(rail);
  expect(screen.getByRole('button', { name: 'Google', pressed: true })).toBeVisible();
  screen.getByRole('button', { name: 'GitHub', pressed: false }).focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'GitHub', pressed: true })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/sign-in', vaultId, entryId, fieldId: null, binding: { provider: 'github', account: null }, agentVisible: false, locale: 'en' }));
 });
 it('keeps provider suggestion mail free of account and Entry data', async () => {
  setup([{ id: methodId, provider: 'google', account: 'private-account', agentVisible: true }]);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit sign-in method' }));
  const link = screen.getByRole('link', { name: 'Missing a provider? Let us know' });
  expect(link).toHaveAttribute('href', 'mailto:contact@example.test?subject=Sign-in%20provider%20suggestion');
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), 'private-draft');
  expect(link).toHaveAttribute('href', 'mailto:contact@example.test?subject=Sign-in%20provider%20suggestion');
 });
 it('renders compact same-provider rows and edits/removes the chosen exact ID', async () => {
  const send = setup([{ id: methodId, provider: 'google', account: 'first@test', agentVisible: true },
   { id: 'custom:bbbbbb22-2222-4222-8222-222222222222', provider: 'google', account: 'second@test', agentVisible: false }]);
  expect(await screen.findByText('first@test')).toBeVisible();
  expect(screen.getByText('second@test')).toBeVisible();
  expect(screen.queryByText(/Agents can see/)).toBeNull();
  await userEvent.click(screen.getAllByRole('button', { name: 'Edit sign-in method' })[0]!);
  expect(screen.getByRole('checkbox')).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Forget sign-in method' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/sign-in', vaultId, entryId, fieldId: methodId, binding: null, agentVisible: false, locale: 'en' }));
 });
 it('empty section contains heading and plus, then adds a typed optional account', async () => {
  const send = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
  await userEvent.click(screen.getByRole('button', { name: 'GitHub', pressed: false }));
  expect(screen.getByRole('button', { name: 'GitHub', pressed: true }).querySelector('img')).not.toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), '  octo  ');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/sign-in', vaultId, entryId, fieldId: null, binding: { provider: 'github', account: 'octo' }, agentVisible: false, locale: 'en' }));
 });
 it('discards provider/account/visibility edits on cancel and restores the original draft', async () => {
  const send = setup([{ id: methodId, provider: 'google', account: 'first@test', agentVisible: true }]);
  const edit = await screen.findByRole('button', { name: 'Edit sign-in method' });
  await userEvent.click(edit);
  await userEvent.click(screen.getByRole('button', { name: 'Apple', pressed: false }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Account (optional)' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), 'discarded');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(send.mock.calls.some(([command]) => command.type === 'workspace/sign-in')).toBe(false);
  expect(edit).toHaveFocus();
  await userEvent.click(edit);
  expect(screen.getByRole('button', { name: 'Google', pressed: true })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Account (optional)' })).toHaveValue('first@test');
  expect(screen.getByRole('checkbox')).toBeChecked();
 });
 it('retains the editor when the worker refuses a write', async () => {
  setup([], true);
  await userEvent.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(screen.getByRole('button', { name: 'Google', pressed: true })).toBeVisible();
 });
});
