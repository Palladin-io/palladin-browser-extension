// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TotpCapturePrompt } from './TotpCapturePrompt';
const review = { status: 'ready' as const, entryScope: null, id: 'candidate', origin: 'https://example.com', issuer: null, account: null,
  defaultTargetId: null, targets: [
    { id: 'one', vaultId: 'vault', entryId: 'alice', action: 'update' as const, label: 'Alice', vaultLabel: 'Personal', hasTotp: true, domainMismatch: false },
    { id: 'two', vaultId: 'vault', entryId: 'bob', action: 'update' as const, label: 'Bob', vaultLabel: 'Personal', hasTotp: false, domainMismatch: false },
    { id: 'new', vaultId: 'vault', entryId: null, action: 'create' as const, label: 'Personal', vaultLabel: 'Personal', hasTotp: false, domainMismatch: false },
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
  const manualReview = { ...review, entryScope: { id: 'bob', vaultId: 'vault' } };
  let finish!: (result: typeof manualReview) => void; let listener!: (message: unknown) => void;
  vi.stubGlobal('chrome', { runtime: { sendMessage: (command: { type: string }) => command.type === 'scan'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 'empty' }),
    onMessage: { addListener: (value: typeof listener) => { listener = value; }, removeListener: () => {} } } });
  try {
    const { unmount } = render(<TotpCaptureSurface revision={0} entry={{ id: 'bob', vaultId: 'vault' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan authenticator QR code' }));
    await act(async () => { listener({ type: 'totp-capture/invalidated' }); finish(manualReview); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan authenticator QR code' })).not.toBeDisabled());
    expect(screen.queryByRole('region', { name: 'Save authenticator' })).not.toBeInTheDocument(); unmount();
  } finally { vi.unstubAllGlobals(); }
});

it.each(['bob', 'missing'])('limits an Entry scan to its worker-approved target: %s', async entryId => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  const send = vi.fn(async (command: { type: string }) => command.type === 'scan' ? { ...review, entryScope: { id: entryId, vaultId: 'vault' }, targets: review.targets.filter(target => target.entryId === entryId), defaultTargetId: entryId === 'bob' ? 'two' : null } : { status: 'empty' });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, onMessage: { addListener() {}, removeListener() {} } } });
  try {
    const view = render(<TotpCaptureSurface revision={0} entry={{ id: entryId, vaultId: 'vault' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan authenticator QR code' }));
    if (entryId === 'bob') {
      expect(await screen.findByLabelText('Credential')).toHaveValue('two');
      expect(screen.queryByRole('option', { name: /Alice/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'two' })));
      expect(send).toHaveBeenCalledWith({ channel: 'palladin.totp-capture', type: 'scan', entry: { id: 'bob', vaultId: 'vault' } });
    } else {
      expect(await screen.findByRole('status')).toHaveTextContent('This Entry cannot be updated');
      expect(screen.queryByRole('button', { name: 'Save authenticator' })).not.toBeInTheDocument();
    }
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('keeps passive review available independently of the selected Entry', async () => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ...review, entryScope: null }), onMessage: { addListener() {}, removeListener() {} } } });
  try {
    const view = render(<><TotpCaptureSurface revision={0} /><TotpCaptureSurface revision={0} entry={{ id: 'unrelated', vaultId: 'vault' }} /></>);
    expect(await screen.findByRole('option', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('warns about a different domain and allows saving after explicit confirmation', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={{ ...review, defaultTargetId: 'two', targets: [{ ...review.targets[1]!, domainMismatch: true }] }} send={send} onDone={() => {}} />);
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Save to this Entry despite the different website'));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'two', confirmDomainMismatch: true })));
});
