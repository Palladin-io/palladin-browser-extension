// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCommand, WorkspaceReply } from '../../shared/workspace/commands';
import { I18nProvider } from '../i18n';
import { createWorkspaceClient } from './client';
import { EntryFields } from './EntryFields';
import { SignInMethodsEditor } from './SignInMethodField';
import type { VaultClient } from '../vault/client';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); }; });
vi.mock('../../shared/config/contact', () => ({ contactEmail: 'contact@example.test' }));
afterEach(() => vi.restoreAllMocks());
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
function setupEditor(fails = false) {
 const onSave = vi.fn(async () => { if (fails) throw new Error('conflict'); });
 render(<I18nProvider locale="en"><SignInMethodsEditor methods={[]} onSave={onSave} /></I18nProvider>);
 return onSave;
}
describe('popup sign-in collection', () => {
 it('hides the whole sign-in section when the Entry has no method', async () => {
  const send = setup();
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'workspace/detail', vaultId, entryId }));
  expect(screen.queryByRole('region', { name: 'Sign-in methods' })).toBeNull();
  expect(screen.queryByText('Sign-in methods')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add a sign-in method' })).toBeNull();
 });
 it('shows configured methods as rows inside the Details card without a separate section', async () => {
  setup([{ id: methodId, provider: 'google', account: 'first@test', agentVisible: false }]);
  const row = (await screen.findByText('first@test')).closest('.detail-field');
  expect(row?.parentElement).toHaveClass('detail-fields');
  expect(document.querySelectorAll('.detail-fields')).toHaveLength(1);
  expect(row).toHaveTextContent('Google');
  expect(screen.queryByText('Sign-in methods')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add a sign-in method' })).toBeNull();
 });
 it('scrolls providers without changing the method and selects with the keyboard', async () => {
  const send = setupEditor();
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
  await waitFor(() => expect(send).toHaveBeenCalledWith(null, { provider: 'github', account: null, agentVisible: false }));
 });
 it('keeps provider suggestion mail free of account and Entry data', async () => {
  setup([{ id: methodId, provider: 'google', account: 'private-account', agentVisible: true }]);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit sign-in method' }));
  const link = screen.getByRole('link', { name: 'Missing a provider? Let us know' });
  expect(link).toHaveAttribute('href', 'mailto:contact@example.test?subject=Sign-in%20provider%20suggestion');
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), 'private-draft');
  expect(link).toHaveAttribute('href', 'mailto:contact@example.test?subject=Sign-in%20provider%20suggestion');
 });
 it('reveals a saved final provider once without stealing focus or resetting user scroll', async () => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
   if (this.getAttribute('role') === 'group' && this.getAttribute('aria-label') === 'Provider') return new DOMRect(0, 0, 200, 100);
   if (this.getAttribute('aria-pressed') === 'true' && this.textContent === 'Facebook') return new DOMRect(384, 0, 88, 100);
   return new DOMRect();
  });
  setup([{ id: methodId, provider: 'facebook', account: null, agentVisible: false }]);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit sign-in method' }));
  const rail = screen.getByRole('group', { name: 'Provider' });
  expect(rail.scrollLeft).toBe(272);
  expect(screen.getByRole('button', { name: 'Facebook', pressed: true })).not.toHaveFocus();
  rail.scrollLeft = 0;
  fireEvent.scroll(rail);
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), 'typing');
  expect(rail.scrollLeft).toBe(0);
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
 it('entry form editor keeps heading and plus, then adds a typed optional account', async () => {
  const send = setupEditor();
  expect(screen.getByText('Sign-in methods')).toBeVisible();
  await userEvent.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
  await userEvent.click(screen.getByRole('button', { name: 'GitHub', pressed: false }));
  expect(screen.getByRole('button', { name: 'GitHub', pressed: true }).querySelector('img')).not.toBeNull();
  await userEvent.type(screen.getByRole('textbox', { name: 'Account (optional)' }), '  octo  ');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(null, { provider: 'github', account: 'octo', agentVisible: false }));
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
  setup([{ id: methodId, provider: 'google', account: null, agentVisible: false }], true);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit sign-in method' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(screen.getByRole('button', { name: 'Google', pressed: true })).toBeVisible();
 });
});
