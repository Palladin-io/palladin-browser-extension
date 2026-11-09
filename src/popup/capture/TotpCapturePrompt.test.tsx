// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TotpCapturePrompt, TotpCaptureSurface } from './TotpCapturePrompt';
const review = { status: 'ready' as const, entryScope: null, id: 'candidate', origin: 'https://example.com', issuer: null, account: null,
  defaultTargetId: null, targets: [
    { id: 'one', vaultId: 'vault', entryId: 'alice', action: 'update' as const, label: 'Alice', vaultLabel: 'Personal', hasTotp: true, domainMismatch: false },
    { id: 'two', vaultId: 'vault', entryId: 'bob', action: 'update' as const, label: 'Bob', vaultLabel: 'Personal', hasTotp: false, domainMismatch: false },
    { id: 'new', vaultId: 'vault', entryId: null, action: 'create' as const, label: 'Personal', vaultLabel: 'Personal', hasTotp: false, domainMismatch: false },
  ] };
it('requires account selection and explicit replacement confirmation', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={review} send={send} onDone={() => {}} />);fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Credential'));fireEvent.click(screen.getByRole('option', { name: /Alice/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Replace the saved authenticator for Alice'));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'one', replace: true })));
});

it('requires a name when creating a Credential and submits the selected Vault', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={{ ...review, targets: review.targets.filter(target => target.action === 'create') }} send={send} onDone={() => {}} />);fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create a login entry' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
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
  await screen.findByRole('button',{name:'Done'}); fireEvent.click(screen.getByRole('button',{name:review.targets[1]!.label}));
  expect(messages).toHaveBeenCalledWith(expect.objectContaining({type:'popup/view/set',state:expect.objectContaining({view:'vault',selected:{id:'committed',vaultId:'vault'}})}));
  expect(done).toHaveBeenCalledOnce();
 } finally {vi.unstubAllGlobals();}
});
it.each(['bob', 'missing'])('limits an Entry scan to its worker-approved target: %s', async entryId => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  const send = vi.fn(async (command: { type: string }) => command.type === 'scan' ? { ...review, entryScope: { id: entryId, vaultId: 'vault' }, targets: review.targets.filter(target => target.entryId === entryId), defaultTargetId: entryId === 'bob' ? 'two' : null } : { status: 'empty' });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, onMessage: { addListener() {}, removeListener() {} } } });
  try {
    const view = render(<TotpCaptureSurface revision={0} entry={{ id: entryId, vaultId: 'vault' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan authenticator QR code' }));
    if (entryId === 'bob') {
      expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /Alice/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'two' })));
      expect(send).toHaveBeenCalledWith({ channel: 'palladin.totp-capture', type: 'scan', entry: { id: 'bob', vaultId: 'vault' } });
    } else {
      expect(await screen.findByRole('status')).toHaveTextContent('This Entry cannot be updated');
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    }
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('keeps passive review available independently of the selected Entry', async () => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ...review, entryScope: null }), onMessage: { addListener() {}, removeListener() {} } } });
  try {
    const view = render(<><TotpCaptureSurface revision={0} /><TotpCaptureSurface revision={0} entry={{ id: 'unrelated', vaultId: 'vault' }} /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByLabelText('Credential'));
    expect(screen.getByRole('option', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('warns about a different domain and allows saving after explicit confirmation', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={{ ...review, defaultTargetId: 'two', targets: [{ ...review.targets[1]!, domainMismatch: true }] }} send={send} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Save authenticator' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('This is the right account'));
  fireEvent.click(screen.getByRole('button', { name: 'Save authenticator' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'two', confirmDomainMismatch: true })));
});

it('shows the manual review only below an expanded QR action without saving on collapse', async () => {
  const { TotpCaptureSurface } = await import('./TotpCapturePrompt');
  const candidate = { ...review, entryScope: { id: 'bob', vaultId: 'vault' }, defaultTargetId: 'two', targets: [{ ...review.targets[1]!, domainMismatch: true }] };
  const send = vi.fn(async () => candidate);
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, onMessage: { addListener() {}, removeListener() {} } } });
  try {
    const view = render(<TotpCaptureSurface revision={0} entry={{ id: 'bob', vaultId: 'vault' }} />);
    await waitFor(() => expect(send).toHaveBeenCalled());
    const toggle = screen.getByRole('button', { name: 'Scan authenticator QR code' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Save authenticator' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const prompt = await screen.findByRole('region', { name: 'Save authenticator' });
    expect(toggle.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Save authenticator' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'save' }));
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it('confirms a scoped mismatch and replacement with Replace, without redundant fields', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const }));
  render(<TotpCapturePrompt review={{ ...review, entryScope: { id: 'alice', vaultId: 'vault' }, defaultTargetId: 'one', targets: [{ ...review.targets[0]!, domainMismatch: true }] }} send={send} onDone={() => {}} />);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText(/Detected on/)).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('The Entry URL does not match this website. Continue?');
  expect(screen.getByRole('alert')).toHaveTextContent('The existing authenticator will be replaced.');
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Cancel', 'Replace']);
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'one', confirmDomainMismatch: true, replace: true })));
});
it('prefills a new authenticator login from its site and safe account hint', () => {
 render(<TotpCapturePrompt review={{...review,account:'alice@example.com',targets:review.targets.filter(target=>target.action==='create')}} send={async()=>({status:'saved'})} onDone={()=>{}} />);
 fireEvent.click(screen.getByRole('button',{name:'Review'})); fireEvent.click(screen.getByRole('button',{name:'Create a login entry'}));
 expect(screen.getByLabelText('Name')).toHaveValue('example.com');expect(screen.getByLabelText('Username')).toHaveValue('alice@example.com');
 expect(screen.getByText('Creates a new login entry with this authenticator.')).toBeInTheDocument();
});
it('retains the edited saved name and account after clearing the authenticator form', async () => {
 render(<TotpCapturePrompt initialExpanded review={{...review,account:'alice@example.com',targets:review.targets.filter(target=>target.action==='create')}} send={async()=>({status:'saved'})} onDone={()=>{}} />);
 fireEvent.click(screen.getByRole('button',{name:'Create a login entry'}));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Synthetic inline account'}});
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'saved@example.com'}});
 fireEvent.click(screen.getByRole('button',{name:'Save authenticator'}));
 expect(await screen.findByText('Synthetic inline account')).toBeVisible();
 expect(screen.getByText('Account: saved@example.com · Authenticator')).toBeVisible();
 expect(screen.queryByLabelText('Name')).toBeNull();
});
it('passes edited unsaved authenticator fields and destination to thumbnail handoff', () => {
 const open=vi.fn();
 render(<TotpCapturePrompt initialExpanded onOpenCapture={open} review={{...review,targets:review.targets.filter(target=>target.action==='create')}} send={async()=>({status:'saved'})} onDone={()=>{}} />);
 fireEvent.click(screen.getByRole('button',{name:'Create a login entry'}));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Edited draft'}});
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'draft-account'}});
 fireEvent.click(screen.getByRole('button',{name:'example.com'}));
 expect(open).toHaveBeenCalledWith(false,expect.objectContaining({kind:'totp',label:'Edited draft',username:'draft-account',targetId:expect.any(String)}));
});
it('retains automatic TOTP review on mute failure and keeps dismiss separate', async () => {
 const send=vi.fn().mockResolvedValueOnce({status:'error'}).mockResolvedValueOnce({status:'dismissed'}),done=vi.fn();
 render(<TotpCapturePrompt review={review} send={send} onDone={done} initialExpanded />);
 fireEvent.click(screen.getByRole('button',{name:'More dismiss options'}));
 expect(send).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('menuitem'));
 await screen.findByRole('alert');expect(done).not.toHaveBeenCalled();
 expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'mute',id:'candidate'}));
 fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));
 await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));
 expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type:'dismiss',id:'candidate'}));
});
it('does not expose site mute in an explicitly requested entry TOTP scan', () => {
 render(<TotpCapturePrompt review={{...review,entryScope:{id:'alice',vaultId:'vault'}}} send={async()=>({status:'dismissed'})} onDone={()=>{}} />);
 expect(screen.getByRole('button',{name:'Cancel'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'More dismiss options'})).toBeNull();
});
