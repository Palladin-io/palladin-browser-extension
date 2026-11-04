// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TotpCapturePrompt } from './TotpCapturePrompt';
const review = { status: 'ready' as const, id: 'candidate', origin: 'https://example.com', issuer: null, account: null,
  defaultTargetId: null, targets: [
    { id: 'one', action: 'update' as const, label: 'Alice', vaultLabel: 'Personal', hasTotp: true },
    { id: 'two', action: 'update' as const, label: 'Bob', vaultLabel: 'Personal', hasTotp: false },
    { id: 'new', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal', hasTotp: false },
  ] };
it('requires account selection and explicit replacement confirmation', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'one' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Replace existing authenticator'));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'one', replace: true })));
});

it('requires a name when creating a Credential and submits the selected Vault', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'new' } });
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My account' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'new', create: { label: 'My account', username: 'alice' } })));
});
it('shows write failures without discarding the user choice', async () => {
  const send = vi.fn(async () => ({ status: 'error' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save authenticator');
  expect(screen.getByLabelText('Credential')).toHaveValue('two');
});
it('renders the native flow in Polish', async () => {
  const { I18nProvider } = await import('../i18n');
  render(<I18nProvider locale="pl"><TotpCapturePrompt review={review} send={async () => ({ status: 'saved' })} onDone={() => {}} /></I18nProvider>);
  expect(screen.getByLabelText('Dane logowania')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Zapisz uwierzytelniacz' })).toBeDisabled();
});
it('does not restore a stale review when a scan finishes after invalidation', async () => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  let finish!: (result: typeof review) => void; let listener!: (message: unknown) => void;
  vi.stubGlobal('chrome', { runtime: { sendMessage: (command: { type: string }) => command.type === 'scan'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 'empty' }),
    onMessage: { addListener: (value: typeof listener) => { listener = value; }, removeListener: () => {} } } });
  try {
    const { unmount } = render(<TotpCaptureSurface revision={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan QR on page' }));
    await act(async () => { listener({ type: 'totp-capture/invalidated' }); finish(review); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan QR on page' })).not.toBeDisabled());
    expect(screen.queryByRole('region', { name: 'Save authenticator' })).not.toBeInTheDocument(); unmount();
  } finally { vi.unstubAllGlobals(); }
});
