// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CaptureFrameApp } from './App';
import type { CaptureFrameConnection } from './frame-connection';
import type { SecretCaptureResult } from '../background/capture/secret-coordinator';

it('loads and saves only the scoped capture, then removes all secret editor fields', async () => {
  const review: SecretCaptureResult = { status: 'review', id: 'candidate', origin: 'https://example.test', candidate: { kind: 'key', value: 'synthetic-capture-secret' }, vaults: [{ id: 'vault', name: 'Personal', isDefault: true }] };
  const send = vi.fn<CaptureFrameConnection['send']>(async command => command.type === 'save' ? { status: 'saved' } : review);
  const connection: CaptureFrameConnection = { kind: 'secret', apiUrl: null, send, ready: vi.fn(), failed: vi.fn(), resize: vi.fn(), close: vi.fn() };
  const runtimeSend = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage: runtimeSend } });
  try {
    render(<CaptureFrameApp connection={connection} />);
    expect(await screen.findByRole('heading', { name: 'Palladin.io' })).toBeVisible();
    const save = await screen.findByRole('button', { name: 'Save key' });
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeVisible());
    expect(document.querySelector('input,textarea')).toBeNull();
    expect(document.body.textContent).not.toContain('synthetic-capture-secret');
    expect(send.mock.calls.map(([command]) => command.type)).toEqual(['get', 'save']);
    expect(runtimeSend).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it('signals failed initialization without mounting a generic popup', async () => {
  const connection: CaptureFrameConnection = { kind: 'login', apiUrl: null, send: vi.fn().mockRejectedValue(new Error('gone')), ready: vi.fn(), failed: vi.fn(), resize: vi.fn(), close: vi.fn() };
  render(<CaptureFrameApp connection={connection} />);
  await waitFor(() => expect(connection.failed).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(connection.ready).not.toHaveBeenCalled();
});
