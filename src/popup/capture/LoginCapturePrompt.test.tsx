// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LoginCapturePrompt } from './LoginCapturePrompt';
import type { NativeLoginCaptureReview } from '../../shared/messaging/native-login-capture';
const review: NativeLoginCaptureReview = { kind: 'credential', prompt: { id: 'capture', site: 'accounts.example.com', state: 'ready',
  targets: [{ id: 'one', action: 'update', label: 'Alice', vaultLabel: 'Personal' }, { id: 'two', action: 'update', label: 'Bob', vaultLabel: 'Personal' }], defaultTargetId: null },
  entry: { entryType: 'credential', label: 'Example', username: 'alice', password: 'captured', url: 'https://accounts.example.com' } };
it('requires an ambiguous account choice and retains edited fields after save failure', async () => {
  const send = vi.fn(async (command) => command.type === 'get' ? { status: 'review' as const, review } : { status: 'unavailable' as const });
  render(<LoginCapturePrompt review={review} send={send} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Save entry' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Where to save'));
  fireEvent.click(screen.getByRole('option', { name: /Alice/ }));
  await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Example'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save'));
  expect(screen.getByLabelText('Name')).toHaveValue('Edited login');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'save', targetId: 'one', entry: expect.objectContaining({ label: 'Edited login' }) }));
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
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep edited label' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(screen.getByLabelText('Name')).toHaveValue('Keep edited label');
  fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'refreshed', entry: expect.objectContaining({ label: 'Keep edited label' }) })));
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
it('keeps signup identity correction available and resets the target after correction', async () => {
  const targets = [{ id: 'personal', action: 'create' as const, label: 'Personal', vaultLabel: 'Personal' }, { id: 'team', action: 'create' as const, label: 'Team', vaultLabel: 'Team' }];
  let selected: 'email' | 'nickname' | null = null;
  const initial = { ...review, prompt: { ...review.prompt, usernameSelection: { selected }, targets: [], defaultTargetId: null } };
  const send = vi.fn(async (command): Promise<import('../../shared/messaging/native-login-capture').NativeLoginCaptureResult> => {
    if (command.type === 'choose-username') { selected = command.choice; return { status: 'accepted' }; }
    return { status: 'review', review: { ...review, prompt: { ...review.prompt, usernameSelection: { selected }, targets, defaultTargetId: 'personal' } } };
  });
  render(<LoginCapturePrompt review={initial} send={send} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  await waitFor(() => expect(screen.getByLabelText('Where to save')).toHaveValue('Personal'));
  fireEvent.click(screen.getByLabelText('Where to save'));
  fireEvent.click(screen.getByRole('option', { name: /Team/ }));
  await waitFor(() => expect(screen.getByLabelText('Where to save')).toHaveValue('Team'));
  fireEvent.click(screen.getByRole('button', { name: 'Nickname' }));
  await waitFor(() => expect(screen.getByLabelText('Where to save')).toHaveValue('Personal'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    await act(async () => { availability({ status: 'availability', available: false }); });
    expect(screen.getByRole('region', { name: 'Save your login?' })).toBeInTheDocument();
    await act(async () => { save({ status: 'saved', action: 'updated' }); });
    expect(await screen.findByText('Login saved')).toBeVisible();
  } finally { unmount(); timer.mockRestore(); vi.unstubAllGlobals(); }
});
it('retains the active editor through unrelated Vault revisions and clears it on actual invalidation', async () => {
  const { act } = await import('@testing-library/react');
  const { LoginCaptureSurface } = await import('./LoginCapturePrompt');
  let refresh!: (value: unknown) => void;
  let listener!: (message: unknown) => void;
  let gets = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => ++gets === 1 ? Promise.resolve({ status: 'review', sourceTabId: 1, review })
    : new Promise(resolve => { refresh = resolve; }), onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} } } });
  const { rerender, unmount } = render(<LoginCaptureSurface revision={0} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Unsaved label' } });
    rerender(<LoginCaptureSurface revision={1} />);
    expect(screen.getByLabelText('Name')).toBe(name);
    expect(name).toHaveValue('Unsaved label');
    await act(async () => { refresh({ status: 'review', sourceTabId: 1, review }); });
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
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    if (phase === 'saved') await act(async () => { save({ status: 'saved', action: 'updated' }); });
    await act(async () => { rejectRefresh(new Error('Worker request interrupted')); });
    expect(screen.getByRole('region', { name: 'Save your login?' })).toBeInTheDocument();
    if (phase === 'saving') await act(async () => { save({ status: 'saved', action: 'updated' }); });
    expect(await screen.findByText('Login saved')).toBeVisible();
  } finally { unmount(); vi.unstubAllGlobals(); }
});
