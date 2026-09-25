// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { VaultClient } from '../vault/client';
import { GeneratorHistoryPanel } from './GeneratorHistoryPanel';

const item = { id: '00000000-0000-4000-8000-000000000001', origin: 'https://example.test', createdAt: 1 };
const client = { armClipboardClear: vi.fn(async () => {}) } as unknown as VaultClient;
afterEach(() => vi.unstubAllGlobals());

it('loads metadata only and reveals a password exclusively after an explicit action', async () => {
  const sendMessage = vi.fn().mockResolvedValueOnce({ ok: true, items: [item] })
    .mockResolvedValueOnce({ ok: true, value: 'synthetic-history-password' });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const user = userEvent.setup();
  render(<GeneratorHistoryPanel client={client} />);
  await screen.findByText('example.test');
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('synthetic-history-password')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Reveal' }));
  await screen.findByText('synthetic-history-password');
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'generator-history/reveal', id: item.id });
  await user.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.queryByText('synthetic-history-password')).toBeNull();
});

it('does not copy an asynchronous reveal after the unlocked screen unmounts', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const sendMessage = vi.fn().mockResolvedValueOnce({ ok: true, items: [item] }).mockReturnValueOnce(pending);
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
  const view = render(<GeneratorHistoryPanel client={client} />);
  await screen.findByText('example.test');
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  view.unmount();
  await act(async () => resolve({ ok: true, value: 'synthetic-history-password' }));
  expect(copy).not.toHaveBeenCalled();
});
