// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TotpCapturePrompt, TotpCaptureSurface } from './TotpCapturePrompt';
const review = { status: 'ready' as const, id: 'candidate', origin: 'https://example.com', issuer: null, account: null,
  defaultTargetId: null, targets: [
    { id: 'one', action: 'update' as const, label: 'Alice', vaultLabel: 'Personal', hasTotp: true },
    { id: 'two', action: 'update' as const, label: 'Bob', vaultLabel: 'Personal', hasTotp: false },
    { id: 'new', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal', hasTotp: false },
  ] };
it('requires account selection and explicit replacement confirmation', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Credential'));fireEvent.click(screen.getByRole('option', { name: /Alice/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Replace existing authenticator'));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'one', replace: true })));
});

it('requires a name when creating a Credential and submits the selected Vault', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={{ ...review, targets: review.targets.filter(target => target.action === 'create') }} send={send} onDone={() => {}} />);fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create a login entry' }));
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My account' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'new', create: { label: 'My account', username: 'alice' } })));
});
it('shows write failures without discarding the user choice', async () => {
  const send = vi.fn(async () => ({ status: 'error' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByLabelText('Credential'));fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save authenticator');
  expect(screen.getByLabelText('Credential')).toHaveValue('Bob');
});
it('renders the native flow in Polish', async () => {
  const { I18nProvider } = await import('../i18n');
  render(<I18nProvider locale="pl"><TotpCapturePrompt review={review} send={async () => ({ status: 'saved' })} onDone={() => {}} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Sprawdź' }));expect(screen.getByLabelText('Dane logowania')).toBeInTheDocument();
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

it('prefers the sole existing target and hides creation when a match exists', () => {
 render(<TotpCapturePrompt review={{ ...review, targets: review.targets.filter(target => target.id !== 'one') }} send={async () => ({status:'saved'})} onDone={() => {}} />);
 fireEvent.click(screen.getByRole('button', {name:'Review'}));expect(screen.getByLabelText('Credential')).toHaveValue('Bob');expect(screen.queryByRole('button',{name:'Create a login entry'})).toBeNull();
});
it('keeps successful confirmation until Done is selected', async () => {
 const done=vi.fn();render(<TotpCapturePrompt review={{...review, targets:[review.targets[1]!]}} send={async()=>({status:'saved'})} onDone={done} />);
 fireEvent.click(screen.getByRole('button',{name:'Review'}));fireEvent.click(screen.getByRole('button',{name:'Save authenticator'}));
 expect(await screen.findByRole('button',{name:'Done'})).toBeInTheDocument();expect(done).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Done'}));expect(done).toHaveBeenCalledOnce();
});

it('keeps saved confirmation across the vault refresh until Done', async () => {
  const one = { ...review, targets: [review.targets[1]!] };
  let saved = false;
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: async (command: { type: string }) => command.type === 'save' ? (saved = true, { status: 'saved' }) : saved ? { status: 'empty' } : one,
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  } });
  try {
    const view = render(<TotpCaptureSurface revision={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
    await screen.findByRole('button', { name: 'Done' });
    view.rerender(<TotpCaptureSurface revision={1} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Authenticator saved')).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});
it('opens the committed Entry from the saved authenticator summary', async () => {
 const { PopupViewProvider } = await import('../view/PopupView');
 const messages = vi.fn(async (command: {type:string}) => command.type === 'popup/view/get' ? {generation:'session',state:null} : null);
 vi.stubGlobal('chrome',{runtime:{sendMessage:messages}});
 try {
  const done = vi.fn(); render(<PopupViewProvider><TotpCapturePrompt review={{...review,targets:[review.targets[1]!]}}
    send={async()=>({status:'saved',entryId:'committed',vaultId:'vault'})} onDone={done}/></PopupViewProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Review'})); fireEvent.click(screen.getByRole('button',{name:'Save authenticator'}));
  await screen.findByRole('button',{name:'Done'}); fireEvent.click(screen.getByRole('button',{name:/^example.com/}));
  expect(messages).toHaveBeenCalledWith(expect.objectContaining({type:'popup/view/set',state:expect.objectContaining({view:'vault',selected:{id:'committed',vaultId:'vault'}})}));
  expect(done).toHaveBeenCalledOnce();
 } finally {vi.unstubAllGlobals();}
});
