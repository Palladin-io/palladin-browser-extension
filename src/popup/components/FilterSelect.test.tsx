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

it('anchors a floating menu above a low control so scroll containers cannot clip its last option', () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, right: 240, top: window.innerHeight - 80, bottom: window.innerHeight - 44, width: 220, height: 36, x: 20, y: 0, toJSON() {} });
  try {
    render(<FilterSelect floating aria-label="Field type" value="text" onValueChange={() => {}}><option value="text">Text</option><option value="totp">One-time code</option></FilterSelect>);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toHaveStyle({ position: 'fixed', bottom: '84px', top: 'auto', width: '220px' });
    fireEvent.keyDown(screen.getByRole('option', { name: 'Text' }), { key: 'End' });
    expect(screen.getByRole('option', { name: 'One-time code' })).toHaveFocus();
  } finally { rect.mockRestore(); }
});
