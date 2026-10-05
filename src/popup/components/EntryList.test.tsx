// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EntryList } from './EntryList';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { VaultClient } from '../vault/client';

afterEach(cleanup);
it('shows accounts on the same host as separate selectable rows, with current-site entries first', () => {
  const entries: EntryMetadata[] = ['Alpha', 'Beta', 'Other'].map((name, index) => ({
    id: String(index), vaultId: 'vault', vaultName: 'Personal', name, type: 1, updatedAt: '',
    urlDomain: index < 2 ? 'example.test' : 'other.test',
  }));
  const onSelect = vi.fn();
  render(<EntryList client={{} as VaultClient} entries={entries} priorityEntries={[entries[1]!]} onSelect={onSelect} />);
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(3);
  expect(buttons[0]).toHaveTextContent('Beta');
  fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
  expect(onSelect).toHaveBeenCalledWith(entries[0]);
});
