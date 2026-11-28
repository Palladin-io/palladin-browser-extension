// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LoginCapturePrompt } from './LoginCapturePrompt';
import type { NativeLoginCaptureReview } from '../../shared/messaging/native-login-capture';
const review: NativeLoginCaptureReview = { kind: 'credential', prompt: { id: 'capture', site: 'accounts.example.com', state: 'ready',
  targets: [{ id: 'one', action: 'update', label: 'Alice', vaultLabel: 'Personal' }, { id: 'two', action: 'update', label: 'Bob', vaultLabel: 'Personal' }], defaultTargetId: null },
  entry: { entryType: 'credential', label: 'Example', username: 'alice', password: 'captured', url: 'https://accounts.example.com' } };
function chooseFromDismissMenu(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'More dismiss options' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}
it('reviews the first matching entry, offers the others from the Dismiss menu and keeps the choice after a failure', async () => {
  const entryFor = (label: string) => ({ ...review.entry, label });
  const send = vi.fn(async (command: import('../../shared/messaging/native-login-capture').NativeLoginCaptureCommand) => command.type === 'get'
    ? { status: 'review' as const, review: { ...review, entry: entryFor(command.targetId === 'two' ? 'Bob entry' : 'Alice entry') } } : { status: 'unavailable' as const });
  render(<LoginCapturePrompt review={review} send={send} onDone={() => {}} />);
  expect(await screen.findByText('Alice entry', { selector: 'strong' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.queryByLabelText('Existing entry')).toBeNull();
  expect(screen.queryByLabelText('Name')).toBeNull();
  chooseFromDismissMenu('Change entry: Bob · Personal');
  expect(await screen.findByText('Bob entry', { selector: 'strong' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save'));
  expect(screen.getByText('Bob entry', { selector: 'strong' })).toBeInTheDocument();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'two', entry: expect.objectContaining({ label: 'Bob entry', password: 'captured' }) }));
});
it('requires explicit confirmation before replacing a different remembered provider account', async () => {
  const send = vi.fn(async () => ({ status: 'saved' as const, action: 'updated' as const }));
  render(<LoginCapturePrompt review={{ kind: 'federated', prompt: { id: 'flow', site: 'example.com', provider: 'google', state: 'ready',
    accounts: [{ id: 'account', label: 'new@example.com', source: 'vault' }], defaultAccountId: 'account',
    targets: [{ id: 'target', action: 'update', label: 'Example', vaultLabel: 'Personal', current: { provider: 'apple', account: 'old@example.com' } }], defaultTargetId: 'target' } }} send={send} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Replace the remembered sign-in method' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'confirm', replace: true })));
});
it('rebinds a failed save to refreshed worker target IDs without losing edits', async () => {
  const initial = { ...review, prompt: { ...review.prompt, targets: review.prompt.targets.slice(0, 1), defaultTargetId: 'one' } };
  let attempts = 0;
  const send = vi.fn(async (command): Promise<import('../../shared/messaging/native-login-capture').NativeLoginCaptureResult> => {
    if (command.type === 'save' && ++attempts === 1) return { status: 'prompt', prompt: { ...initial.prompt,
      targets: [{ ...initial.prompt.targets[0]!, id: 'refreshed' }], defaultTargetId: 'refreshed', error: 'save-failed' } };
    return { status: 'saved', action: 'updated' };
  });
  render(<LoginCapturePrompt review={initial} send={send} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'refreshed', entry: expect.objectContaining({ password: 'captured' }) })));
});
it('discards a review fetched after navigation invalidation', async () => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let resolve!: (result: unknown) => void;
  let listener!: (message: unknown) => void;
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => new Promise(finish => { resolve = finish; }),
    onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} } } });
  try {
    render(<LoginCaptureSurface revision={0} />);
    await act(async () => { listener({ type: 'login-capture/invalidated' }); resolve({ status: 'review', review }); });
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
it('keeps signup identity correction available and keeps the chosen Vault and edits after correction', async () => {
  const targets = [{ id: 'personal', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal' }, { id: 'team', action: 'create' as const, label: 'Team', vaultLabel: 'Team' }];
  let selected: 'email' | 'nickname' | null = null;
  const usernameOptions = { email: 'alice@example.com', nickname: 'alice' };
  const initial = { ...review, usernameOptions, prompt: { ...review.prompt, usernameSelection: { selected }, targets: [], defaultTargetId: null } };
  const send = vi.fn(async (command): Promise<import('../../shared/messaging/native-login-capture').NativeLoginCaptureResult> => {
    if (command.type === 'choose-username') { selected = command.choice; return { status: 'accepted' }; }
    return { status: 'review', review: { ...review, usernameOptions, entry: { ...review.entry, username: usernameOptions[selected ?? 'email'] },
      prompt: { ...review.prompt, usernameSelection: { selected }, targets, defaultTargetId: 'personal' } } };
  });
  render(<LoginCapturePrompt review={initial} send={send} onDone={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await waitFor(() => expect(screen.getByRole('combobox', {name:'Save to Vault'})).toHaveTextContent('Personal'));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'choose-username', choice: 'email' }));
  expect(screen.getByText('alice@example.com', { selector: 'small' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', {name:'Save to Vault'}));
  fireEvent.click(screen.getByRole('option', { name: /Team/ }));
  await waitFor(() => expect(screen.getByRole('combobox', {name:'Save to Vault'})).toHaveTextContent('Team'));
  fireEvent.click(screen.getByRole('button', { name: 'More', expanded: false }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited name' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Username' }));
  fireEvent.click(screen.getByRole('option', { name: 'alice (Nickname)' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'choose-username', choice: 'nickname' })));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Username' })).toHaveTextContent('alice'));
  expect(screen.getByRole('combobox', {name:'Save to Vault'})).toHaveTextContent('Team');
  expect(screen.getByLabelText('Name')).toHaveValue('Edited name');
  expect(send.mock.calls.some(([command]) => command.type === 'save')).toBe(false);
});
it('ignores a stale availability reply while an explicit save is in flight', async () => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let poll!: () => void;
  let availability!: (value: unknown) => void;
  let save!: (value: unknown) => void;
  const actualInterval = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, delay) => {
    if (delay !== 5_000) return actualInterval(handler, delay);
    if (delay === 5_000) poll = () => { if (typeof handler === 'function') handler(); };
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: (command: { type: string }) => command.type === 'get'
      ? Promise.resolve({ status: 'review', sourceTabId: 1, review: { ...review, prompt: { ...review.prompt, defaultTargetId: 'one' } } })
      : new Promise(resolve => { if (command.type === 'check') availability = resolve; else if (command.type === 'save') save = resolve; }),
    onMessage: { addListener: () => {}, removeListener: () => {} },
  } });
  const { unmount } = render(<LoginCaptureSurface revision={0} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await act(async () => { poll(); });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    await act(async () => { availability({ status: 'availability', available: false }); });
    expect(screen.getByRole('region', { name: 'Update password' })).toBeInTheDocument();
    await act(async () => { save({ status: 'saved', action: 'updated' }); });
    expect(await screen.findByRole('status')).toHaveTextContent('Updated');
  } finally { unmount(); timer.mockRestore(); vi.unstubAllGlobals(); }
});
it('retains the active editor through unrelated Vault revisions and clears it on actual invalidation', async () => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let refresh!: (value: unknown) => void;
  let listener!: (message: unknown) => void;
  let gets = 0;
  const newLogin = { ...review, prompt: { ...review.prompt, targets: [{ id: 'vault', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal' }], defaultTargetId: 'vault' } };
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => ++gets === 1 ? Promise.resolve({ status: 'review', sourceTabId: 1, review: newLogin })
    : new Promise(resolve => { refresh = resolve; }), onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} } } });
  const { rerender, unmount } = render(<LoginCaptureSurface revision={0} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Unsaved label' } });
    rerender(<LoginCaptureSurface revision={1} />);
    expect(screen.getByLabelText('Name')).toBe(name);
    expect(name).toHaveValue('Unsaved label');
    await act(async () => { refresh({ status: 'review', sourceTabId: 1, review: newLogin }); });
    expect(screen.getByLabelText('Name')).toBe(name);
    expect(name).toHaveValue('Unsaved label');
    await act(async () => { listener({ type: 'login-capture/invalidated', tabId: 1 }); });
    expect(screen.queryByLabelText('Name')).toBeNull();
  } finally { unmount(); vi.unstubAllGlobals(); }
});
it.each(['saving', 'saved'] as const)('ignores an outstanding refresh rejection while %s', async phase => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let rejectRefresh!: (reason: Error) => void;
  let save!: (value: unknown) => void;
  let gets = 0;
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: (command: { type: string }) => command.type === 'get'
      ? ++gets === 1 ? Promise.resolve({ status: 'review', sourceTabId: 1, review: { ...review, prompt: { ...review.prompt, defaultTargetId: 'one' } } })
        : new Promise((_resolve, reject) => { rejectRefresh = reject; })
      : new Promise(resolve => { if (command.type === 'save') save = resolve; }),
    onMessage: { addListener: () => {}, removeListener: () => {} },
  } });
  const { rerender, unmount } = render(<LoginCaptureSurface revision={0} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    rerender(<LoginCaptureSurface revision={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    if (phase === 'saved') await act(async () => { save({ status: 'saved', action: 'updated' }); });
    await act(async () => { rejectRefresh(new Error('Worker request interrupted')); });
    expect(screen.getByRole('region', { name: 'Update password' })).toBeInTheDocument();
    if (phase === 'saving') await act(async () => { save({ status: 'saved', action: 'updated' }); });
    expect(await screen.findByRole('status')).toHaveTextContent('Updated');
  } finally { unmount(); vi.unstubAllGlobals(); }
});
it('discovers a same-document SPA capture after the surface initially has no prompt', async () => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let listener!: (message: unknown) => void;
  let gets = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => Promise.resolve({ status: 'review', sourceTabId: 1, review: ++gets === 1 ? null : review }),
    onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} } } });
  const { unmount } = render(<LoginCaptureSurface revision={0} />);
  try {
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    await act(async () => { listener({ type: 'login-capture/available', tabId: 1 }); });
    expect(await screen.findByRole('button', { name: 'Review' })).toBeVisible();
  } finally { unmount(); vi.unstubAllGlobals(); }
});
it('shows only the new password with a preview for a password update and saves the worker entry', async () => {
  const send = vi.fn(async () => ({status:'saved' as const,action:'updated' as const}));
  render(<LoginCapturePrompt review={{...review,prompt:{...review.prompt,defaultTargetId:'one'}}} send={send} onDone={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Review'}));
  const password = screen.getByLabelText('New password');
  expect(password).toHaveValue('captured'); expect(password).toHaveAttribute('type','password');
  expect(screen.queryByLabelText('Username')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show New password'}));
  expect(password).toHaveAttribute('type','text');
  fireEvent.click(screen.getByRole('checkbox',{name:'Automatically update passwords for this account'}));
  fireEvent.click(screen.getByRole('button',{name:'Update password'}));
  expect(await screen.findByRole('status')).toHaveTextContent('Updated');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'save',targetId:'one',autoUpdate:true,entry:review.entry}));
  expect(screen.queryByLabelText('New password')).toBeNull();
});
it('lets a password-update review create a new login in any writable Vault', async () => {
  const targets = [{ id: 'one', action: 'update' as const, label: 'Alice', vaultLabel: 'Personal' },
    { id: 'new-personal', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal' }, { id: 'new-team', action: 'create' as const, label: 'Team', vaultLabel: 'Team' }];
  const send = vi.fn(async (command: import('../../shared/messaging/native-login-capture').NativeLoginCaptureCommand) => command.type === 'get'
    ? { status: 'review' as const, review: { ...review, prompt: { ...review.prompt, targets, defaultTargetId: 'one' } } } : { status: 'saved' as const, action: 'created' as const });
  render(<LoginCapturePrompt initialExpanded review={{ ...review, prompt: { ...review.prompt, targets, defaultTargetId: 'one' } }} send={send} onDone={() => {}} />);
  chooseFromDismissMenu('Create a new entry');
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Save to Vault' })).toBeEnabled());
  fireEvent.click(screen.getByRole('combobox', { name: 'Save to Vault' }));
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Personal', 'Team']);
  fireEvent.click(screen.getByRole('option', { name: 'Team' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Save to Vault' })).toHaveTextContent('Team'));
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'new-team' })));
});
it('saves a new login from the password and Vault, with the other fields behind More', async () => {
  const send = vi.fn(async () => ({status:'saved' as const,action:'created' as const}));
  render(<LoginCapturePrompt initialExpanded review={{...review,prompt:{...review.prompt,targets:[{id:'vault',action:'create',label:'Personal',vaultLabel:'Personal'}],defaultTargetId:'vault'}}} send={send} onDone={()=>{}} />);
  const more = screen.getByRole('button',{name:'More'});
  expect(more).toHaveAttribute('aria-expanded','false');
  expect(more.closest('.capture-compact-row')).toContainElement(screen.getByRole('combobox',{name:'Save to Vault'}));
  expect(screen.getByLabelText('Password')).toHaveValue('captured');
  expect(screen.getByLabelText('Username').closest('.capture-more-panel')).toHaveAttribute('inert');
  fireEvent.click(more);
  expect(screen.getByLabelText('Username').closest('.capture-more-panel')).not.toHaveAttribute('inert');
  fireEvent.click(screen.getByRole('button',{name:'Save login'}));
  await waitFor(()=>expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'save',targetId:'vault',entry:expect.objectContaining({username:'alice',password:'captured'})})));
});
it('offers a Vault selector for a new login rather than an existing-entry search', () => {
  render(<LoginCapturePrompt review={{...review,prompt:{...review.prompt,targets:[{id:'vault',action:'create',label:'Personal',vaultLabel:'Personal'}],defaultTargetId:'vault'}}} send={async()=>({status:'stale'})} onDone={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Review'}));
  expect(screen.getByRole('combobox',{name:'Save to Vault'})).toHaveTextContent('Personal');
  expect(screen.getByRole('button',{name:'Save login'})).toBeEnabled();
});
it('confirms the OAuth account before choosing a new named login entry', async () => {
 const send=vi.fn(async()=>({status:'saved' as const,action:'created' as const}));
 render(<LoginCapturePrompt review={{kind:'federated',prompt:{id:'flow',site:'example.com',provider:'google',state:'ready',accounts:[{id:'account',label:'alice@example.com',source:'vault'}],defaultAccountId:'account',targets:[{id:'create',action:'create',label:'example.com',vaultLabel:'Personal',current:null}],defaultTargetId:'create'}}} send={send} onDone={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Review'}));
 expect(screen.getByRole('img',{name:'Google'})).toBeVisible();
 expect(screen.getByLabelText('Which Google account did you use?')).toHaveValue('alice@example.com');
 expect(screen.getByText('New entry · Personal')).toBeInTheDocument();
 expect(screen.queryByLabelText('Entry name')).toBeNull();
 chooseFromDismissMenu('Edit entry');
 expect(screen.getByLabelText('Entry name')).toHaveValue('example.com');
 fireEvent.change(screen.getByLabelText('Entry name'),{target:{value:'Work GitHub'}});
 fireEvent.click(screen.getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'confirm',entryName:'Work GitHub',targetId:'create'})));
 expect(await screen.findByText(/Google · alice@example\.com$/)).toBeVisible();
});

it('saves an OAuth account typed by the user and never sends it as a listed account id', async () => {
  const send = vi.fn(async () => ({status:'saved' as const,action:'updated' as const}));
  render(<LoginCapturePrompt initialExpanded review={{kind:'federated',prompt:{id:'flow',site:'example.com',provider:'github',state:'ready',accounts:[{id:'account',label:'alice@example.com',source:'vault'}],defaultAccountId:null,targets:[{id:'existing',action:'update',label:'Work',vaultLabel:'Personal',current:null}],defaultTargetId:'existing'}}} send={send} onDone={()=>{}} />);
  const account = screen.getByRole('combobox',{name:'Which GitHub account did you use?'});
  expect(screen.getByRole('button',{name:'Save'})).toBeDisabled();
  fireEvent.change(account,{target:{value:' octo-cat '}});
  fireEvent.keyDown(account,{key:'Enter'});
  expect(account).toHaveValue(' octo-cat ');
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'confirm',account:'octo-cat',targetId:'existing'})));
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({accountId:expect.anything()}));
  expect(await screen.findByText(/GitHub · octo-cat$/)).toBeVisible();
});

it('retries an OAuth save on the rebuilt prompt with the typed account and refreshed IDs', async () => {
  const prompt = {id:'flow',site:'example.com',provider:'github' as const,state:'ready' as const,accounts:[],defaultAccountId:null,
    targets:[{id:'old-target',action:'update' as const,label:'Work',vaultLabel:'Personal',current:null}],defaultTargetId:'old-target'};
  const send = vi.fn().mockResolvedValueOnce({status:'prompt',prompt:{...prompt,targets:[{...prompt.targets[0]!,id:'new-target'}],defaultTargetId:'new-target',error:'save-failed'}})
    .mockResolvedValueOnce({status:'saved',action:'updated'});
  render(<LoginCapturePrompt initialExpanded review={{kind:'federated',prompt}} send={send} onDone={()=>{}} />);
  const account = screen.getByRole('combobox',{name:'Which GitHub account did you use?'});
  fireEvent.change(account,{target:{value:'octo-cat'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(account).toHaveValue('octo-cat');
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type:'confirm',targetId:'new-target',account:'octo-cat'})));
});
it('hands a typed OAuth account to the popup and restores it there', () => {
  const prompt = {id:'flow',site:'example.com',provider:'github' as const,state:'ready' as const,accounts:[],defaultAccountId:null,
    targets:[{id:'existing',action:'update' as const,label:'Work',vaultLabel:'Personal',current:null}],defaultTargetId:'existing'};
  const open = vi.fn();
  const view = render(<LoginCapturePrompt initialExpanded onOpenCapture={open} review={{kind:'federated',prompt}} send={vi.fn()} onDone={()=>{}} />);
  fireEvent.change(screen.getByRole('combobox',{name:'Which GitHub account did you use?'}),{target:{value:'octo-cat'}});
  fireEvent.click(screen.getByRole('button',{name:'Work'}));
  expect(open).toHaveBeenCalledWith(false, expect.objectContaining({kind:'login',typedAccount:'octo-cat',targetId:'existing'}));
  view.unmount();
  render(<LoginCapturePrompt initialExpanded initialDraft={open.mock.calls[0]![1]} review={{kind:'federated',prompt}} send={vi.fn()} onDone={()=>{}} />);
  expect(screen.getByRole('combobox',{name:'Which GitHub account did you use?'})).toHaveValue('octo-cat');
  expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();
});

it('defaults OAuth to the existing match and creates only after explicitly choosing New', async () => {
  const send = vi.fn(async () => ({status:'saved' as const,action:'created' as const}));
  render(<LoginCapturePrompt review={{kind:'federated',prompt:{id:'flow',site:'example.com',provider:'google',state:'ready',accounts:[{id:'account',label:'alice@example.com',source:'vault'}],defaultAccountId:'account',targets:[{id:'existing',action:'update',label:'Work',vaultLabel:'Personal',current:null},{id:'create',action:'create',label:'example.com',vaultLabel:'Personal',current:null}],defaultTargetId:'existing'}}} send={send} onDone={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Review'}));
  expect(screen.getByText('Work',{selector:'strong'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Existing entry')).toBeNull();
  expect(screen.queryByLabelText('Entry name')).toBeNull();
  chooseFromDismissMenu('Create a new entry');
  expect(screen.getByLabelText('Entry name')).toHaveValue('example.com');
  fireEvent.click(screen.getByRole('button', { name: 'More dismiss options' }));
  expect(screen.getByRole('menuitem',{name:'Add to Work'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More dismiss options' }));
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'confirm',targetId:'create',accountId:'account'})));
});
it('restores partial form edits and update consent without reading or saving during handoff', () => {
 const send=vi.fn();const open=vi.fn();
 const draft={kind:'login' as const,targetId:'one',accountId:'',methodMode:'update' as const,entryName:'',autoUpdate:true,replace:false,
  form:{fields:{label:'Edited unfinished',username:'edited-account',password:'edited-password',url:'https://accounts.example.com'},customFields:[{id:'custom:one',label:'',type:'totp' as const,value:'otpauth://unfinished'}],methods:[],presentation:{}}};
 render(<LoginCapturePrompt initialExpanded initialDraft={draft} review={review} send={send} onOpenCapture={open} onDone={()=>{}}/>);
 expect(screen.getByLabelText('Name')).toHaveValue('Edited unfinished');
 expect(screen.getByLabelText('New password')).toHaveValue('edited-password');
 expect(screen.getByRole('checkbox')).toBeChecked();
 fireEvent.click(screen.getByText('Additional fields'));
 expect(screen.getByLabelText('Name of additional field 1')).toHaveValue('');
 expect(screen.getByLabelText('Value of additional field 1')).toHaveValue('otpauth://unfinished');
 fireEvent.click(screen.getByRole('button',{name:'Example'}));
 expect(open).toHaveBeenCalledWith(false,expect.objectContaining({targetId:'one',autoUpdate:true,form:expect.objectContaining({customFields:draft.form.customFields})}));
 expect(send).not.toHaveBeenCalled();
});
it('reloads a handed-off target without form edits before an update can save it', async () => {
 const send=vi.fn(async (command: import('../../shared/messaging/native-login-capture').NativeLoginCaptureCommand) => command.type === 'get'
  ? { status: 'review' as const, review: { ...review, entry: { ...review.entry, label: 'Bob entry', username: 'bob' } } } : { status: 'saved' as const, action: 'updated' as const });
 const draft={kind:'login' as const,targetId:'two',accountId:'',methodMode:'update' as const,entryName:'',autoUpdate:false,replace:false,form:null};
 render(<LoginCapturePrompt initialExpanded initialDraft={draft} review={{...review,prompt:{...review.prompt,defaultTargetId:'one'}}} send={send} onDone={()=>{}}/>);
 await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'get', targetId: 'two' })));
 await waitFor(() => expect(screen.getByRole('button',{name:'Update password'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Update password'}));
 await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'two', entry: expect.objectContaining({ label: 'Bob entry', username: 'bob' }) })));
});
it.each(['credential', 'federated'] as const)('mutes %s capture only after selecting the site action and retains review after failure', async kind => {
 const input: NativeLoginCaptureReview = kind === 'credential' ? {...review,prompt:{...review.prompt,defaultTargetId:'one'}} : {kind:'federated',prompt:{id:'capture',site:'accounts.example.com',state:'ready',provider:'google',accounts:[],defaultAccountId:null,targets:[],defaultTargetId:null}};
 const send=vi.fn().mockResolvedValueOnce({status:'unavailable'}).mockResolvedValueOnce({status:'dismissed'}),done=vi.fn();
 render(<LoginCapturePrompt review={input} send={send} onDone={done} initialExpanded />);
 fireEvent.click(screen.getByRole('button',{name:'More dismiss options'}));
 expect(send).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('menuitem',{name:/Don't offer/}));
 await screen.findByRole('alert');expect(done).not.toHaveBeenCalled();
 expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'mute',kind,promptId:'capture'}));
 fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));
 await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));
 expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type:'dismiss',kind,promptId:'capture'}));
});
