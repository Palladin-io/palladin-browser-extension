// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { FilterSelect } from './FilterSelect';
afterEach(cleanup);
it('supports keyboard selection and returns focus to the trigger', () => {
  const change = vi.fn();
  render(<FilterSelect aria-label="Status" value="" onValueChange={change}><option value="">All</option><option value="active">Active</option><option value="revoked">Revoked</option></FilterSelect>);
  const trigger = screen.getByRole('combobox');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: 'All' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('option', { name: 'All' }), { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: 'Active' })).toHaveFocus();
  fireEvent.click(screen.getByRole('option', { name: 'Active' }));
  expect(change).toHaveBeenCalledWith('active');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('dismisses without changing the value on Escape and outside interaction', () => {
  const change = vi.fn();
  render(<FilterSelect aria-label="Status" value="" onValueChange={change}><option value="">All</option></FilterSelect>);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('option'), { key: 'Escape' });
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

it('leaves the popup on Tab rather than traversing its options', async () => {
  const user = userEvent.setup();
  render(<><FilterSelect aria-label="Status" value="" onValueChange={() => {}}><option value="">All</option><option value="active">Active</option></FilterSelect><button>Next</button></>);
  await user.click(screen.getByRole('combobox'));
  await user.tab();
  expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('keeps multiple choices open and supports deselection and clearing', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const content = [<option key="all" value="">All</option>, <option key="active" value="active">Active</option>, <option key="revoked" value="revoked">Revoked</option>];
  const view = render(<FilterSelect multiple aria-label="Status" value={[]} onValueChange={changed}>{content}</FilterSelect>);
  await user.click(screen.getByRole('combobox'));
  await user.click(screen.getByRole('option', { name: 'Active' }));
  expect(changed).toHaveBeenLastCalledWith(['active']);
  view.rerender(<FilterSelect multiple aria-label="Status" value={['active']} onValueChange={changed}>{content}</FilterSelect>);
  await user.click(screen.getByRole('option', { name: 'Revoked' }));
  expect(changed).toHaveBeenLastCalledWith(['active', 'revoked']);
  view.rerender(<FilterSelect multiple aria-label="Status" value={['active', 'revoked']} onValueChange={changed}>{content}</FilterSelect>);
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  await user.click(screen.getByRole('option', { name: 'Active' }));
  expect(changed).toHaveBeenLastCalledWith(['revoked']);
  await user.click(screen.getByRole('option', { name: 'All' }));
  expect(changed).toHaveBeenLastCalledWith([]);
  expect(screen.getByRole('listbox')).toBeInTheDocument();
});
