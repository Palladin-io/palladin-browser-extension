// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { EntryAutocomplete, type EntryAutocompleteOption } from './EntryAutocomplete';
afterEach(cleanup);
const options: EntryAutocompleteOption[] = Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: `Account ${index}`, detail: `user${index}@example.com · Personal` }));
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('');
  return <EntryAutocomplete label="Existing entry" options={options} value={value} onValueChange={setValue} disabled={disabled} />;
}
it('filters the complete eligible list and selects a result without a second search field', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const input = screen.getByRole('combobox');
  await user.type(input, 'user11');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.click(screen.getByRole('option', { name: /Account 11/ }));
  expect(input).toHaveValue('Account 11'); expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
});
it('loads five choices at a time and resets the batch for a new query', async () => {
  const user = userEvent.setup(); render(<Harness />); await user.click(screen.getByRole('combobox'));
  expect(screen.getAllByRole('option')).toHaveLength(5);
  const list = screen.getByRole('listbox');
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, value: 200 } });
  fireEvent.scroll(list); expect(screen.getAllByRole('option')).toHaveLength(10);
  await user.type(screen.getByRole('combobox'), 'Account 1'); expect(screen.getAllByRole('option')).toHaveLength(3);
});
it('supports keyboard selection while keeping focus on the combobox', async () => {
  const user = userEvent.setup(); render(<Harness />);const input=screen.getByRole('combobox');
  await user.click(input);await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(input).toHaveValue('Account 1');expect(input).toHaveFocus();expect(screen.queryByRole('listbox')).toBeNull();
  await user.click(input);await user.keyboard('{Escape}');expect(input).toHaveValue('Account 1');expect(screen.queryByRole('listbox')).toBeNull();
});
it('clears a previous target when editing and closes on outside interaction', async () => {
  const user=userEvent.setup();const change=vi.fn();render(<EntryAutocomplete label="Existing entry" options={options} value="0" onValueChange={change} />);
  await user.type(screen.getByRole('combobox'),'x');expect(change).toHaveBeenCalledWith('');
  fireEvent.pointerDown(document.body);expect(screen.queryByRole('listbox')).toBeNull();
});
it('shows empty results and closes when disabled', async () => {
  const user=userEvent.setup();const view=render(<Harness />);await user.type(screen.getByRole('combobox'),'missing');expect(screen.getByRole('status')).toHaveTextContent('No matching entries');
  view.rerender(<Harness disabled />);expect(screen.getByRole('combobox')).toBeDisabled();expect(screen.queryByRole('listbox')).toBeNull();
});

it('shows the account before the entry and Vault and marks an existing authenticator', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<EntryAutocomplete label="Existing entry" options={[{id:'entry',name:'Work',account:'alice@example.com',detail:'Personal',hasTotp:true}]} value="" onValueChange={change} />);
  await user.type(screen.getByRole('combobox'), 'alice');
  const option = screen.getByRole('option');
  expect(option).toHaveTextContent('alice@example.comWork · Personal');
  expect(screen.getByLabelText('Authenticator already saved')).toBeInTheDocument();
  await user.click(option);
  expect(change).toHaveBeenLastCalledWith('entry');
});
