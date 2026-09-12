// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSession } from './useSession';
import type { SessionClient } from './client';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const client = (overrides: Partial<SessionClient> = {}): SessionClient => ({
  getStatus: async () => 'locked', getCapabilities: async () => ({ runtimeUnlock: false }),
  login: async () => ({ status: 'unlocked' }), completeTotp: async () => 'unlocked', cancelTotp: async () => {},
  unlock: async () => 'unlocked', lock: async () => {}, logout: async () => {}, ...overrides,
});

describe('surface session results cannot override newer worker state', () => {
  it.each(['resolve', 'reject'] as const)('ignores late initial status %s after worker unlock', async outcome => {
    const read = deferred<'locked'>(), api = client({ getStatus: () => read.promise });
    const { result } = renderHook(() => useSession(api));
    act(() => result.current.synchronize('unlocked'));
    await act(async () => { if (outcome === 'resolve') read.resolve('locked'); else read.reject(new Error('worker restarted')); });
    expect(result.current.phase).toBe('unlocked');
  });
  it.each(['signIn', 'unlock', 'submitTotp'] as const)('ignores late %s success after worker lock/logout', async method => {
    const unlock = deferred<'unlocked'>(), login = deferred<{ status: 'unlocked' }>();
    const api = client({ login: method === 'submitTotp' ? async () => ({ status: 'totp-required', challengeToken: 'synthetic-challenge' }) : () => login.promise,
      unlock: () => unlock.promise, completeTotp: () => unlock.promise });
    const { result } = renderHook(() => useSession(api));
    await waitFor(() => expect(result.current.phase).toBe('locked'));
    if (method === 'submitTotp') await act(() => result.current.signIn('synthetic@example.test', 'synthetic-password'));
    let pending!: Promise<void>;
    act(() => { pending = method === 'signIn' ? result.current.signIn('synthetic@example.test', 'synthetic-password')
      : method === 'unlock' ? result.current.unlock('synthetic-password') : result.current.submitTotp('123456'); });
    act(() => result.current.synchronize('signed-out'));
    await act(async () => { login.resolve({ status: 'unlocked' }); unlock.resolve('unlocked'); await pending; });
    expect(result.current.phase).toBe('signed-out');
  });
  it('ignores late manual unlock after a newer explicit sign-out without a worker event', async () => {
    const unlock = deferred<'unlocked'>(), api = client({ unlock: () => unlock.promise });
    const { result } = renderHook(() => useSession(api));
    await waitFor(() => expect(result.current.phase).toBe('locked'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.unlock('synthetic-password'); });
    await act(() => result.current.signOut());
    await act(async () => { unlock.resolve('unlocked'); await pending; });
    expect(result.current.phase).toBe('signed-out');
  });
});
