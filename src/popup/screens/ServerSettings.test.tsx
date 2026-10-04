// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ServerConfigClientError, type ConnectionClient } from '../config/client';
import { ServerSettings } from './ServerSettings';

function client(): ConnectionClient {
  return {
    get: vi.fn(async () => ({ ok: true as const, state: { connections: [], activeApiUrl: null }, apiUrl: 'https://api.example.test', changed: false })),
    save: vi.fn<ConnectionClient["save"]>(async connection => ({ ok: true as const, state: { connections: [connection], activeApiUrl: connection.apiUrl }, apiUrl: connection.apiUrl, changed: true })),
  };
}
async function fill() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Connection name'), 'My server');
  await user.type(screen.getByLabelText('Panel URL'), 'https://panel.example.test');
  return user;
}
describe('connection settings', () => {
  it('saves the explicit pair with shared unlock enabled by default', async () => {
    const c = client(); const onChanged = vi.fn();
    render(<ServerSettings connectionsClient={c} onChanged={onChanged} />);
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Save and activate' }));
    await waitFor(() => expect(c.save).toHaveBeenCalledWith({ name: 'My server', apiUrl: 'https://api.example.test', webUrl: 'https://panel.example.test', allowHttp: false, sharedUnlockEnabled: true }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('restores a complete production pair that can be saved', async () => {
    const c = client(); render(<ServerSettings connectionsClient={c} onChanged={vi.fn()} />);
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'Use production' }));
    expect(screen.getByRole('button', { name: 'Save and activate' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save and activate' }));
    expect(c.save).toHaveBeenCalledWith({ name: 'Palladin', apiUrl: 'https://api.palladin.io',
      webUrl: 'https://palladin.io', allowHttp: false, sharedUnlockEnabled: true });
  });
  it('requires HTTP consent and resets it when either address changes', async () => {
    const c = client(); render(<ServerSettings connectionsClient={c} onChanged={vi.fn()} />);
    const user = await fill(); const api = screen.getByLabelText('Server URL');
    await user.clear(api); await user.type(api, 'http://192.168.1.5:5000');
    expect(screen.getByRole('button', { name: 'Save and activate' })).toBeDisabled();
    await user.click(screen.getByLabelText('Allow unencrypted HTTP for these API and panel addresses'));
    expect(screen.getByRole('button', { name: 'Save and activate' })).toBeEnabled();
    await user.type(screen.getByLabelText('Panel URL'), '/other');
    expect(screen.getByRole('button', { name: 'Save and activate' })).toBeDisabled();
    expect(c.save).not.toHaveBeenCalled();
  });
  it('shows denied browser access without changing the active connection', async () => {
    const c = client(); c.save = vi.fn(async () => { throw new ServerConfigClientError('permission-denied'); });
    const changed = vi.fn(); render(<ServerSettings connectionsClient={c} onChanged={changed} />);
    const user = await fill(); await user.click(screen.getByRole('button', { name: 'Save and activate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Allow access');
    expect(changed).not.toHaveBeenCalled();
  });
});
