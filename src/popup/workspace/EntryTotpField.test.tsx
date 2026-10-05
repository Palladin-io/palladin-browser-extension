// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EntryTotpField } from './EntryTotpField';
import { createWorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows one visible code, counts down, refreshes at expiry and copies the fresh value', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValueOnce({ ok: true, data: { value: '123456', expiresIn: 2 } })
    .mockResolvedValue({ ok: true, data: { value: '654321', expiresIn: 30 } });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const armClipboardClear = vi.fn().mockResolvedValue(undefined);
  await act(async () => { render(<EntryTotpField client={createWorkspaceClient(send)} vaultClient={{ armClipboardClear } as unknown as VaultClient} vaultId="vault" entryId="entry" fieldId="credential.totp" label="TOTP" />); });
  expect(screen.getAllByText('123 456')).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('1s')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByText('123 456')).toBeNull();
  expect(screen.getByText('654 321')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button')); });
  expect(writeText).toHaveBeenCalledWith('654321');
  expect(armClipboardClear).toHaveBeenCalledOnce();
});

it('removes expired codes on failure without retrying each second and stops after unmount', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValueOnce({ ok: true, data: { value: '123456', expiresIn: 1 } }).mockRejectedValue(new Error('unavailable'));
  let view: ReturnType<typeof render>;
  await act(async () => { view = render(<EntryTotpField client={createWorkspaceClient(send)} vaultClient={{} as VaultClient} vaultId="vault" entryId="entry" fieldId="custom-totp" label="TOTP" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByText('123 456')).toBeNull();
  expect(send).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  view!.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(send).toHaveBeenCalledTimes(2);
});
