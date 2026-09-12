import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedUnlockApi } from './api';
import fixtures from './fixtures/session-api-v1.json';
const apiUrl = 'https://api.example.test';
const commit = fixtures.responses.find(row => row.type === 'commit')!.body;
afterEach(() => vi.useRealTimers());
describe('receiver own-lineage cleanup boundary', () => {
  it.each(['abort', 'server'] as const)('observes an available late commit after %s before rejecting it', async kind => {
    const abort = new AbortController(); let current = apiUrl;
    let respond!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise(resolve => { respond = resolve; }));
    const api = new SharedUnlockApi(fetcher, () => current); const issued = vi.fn();
    const pending = api.commit(apiUrl, 'operation', 'synthetic-proof', abort.signal, issued);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    if (kind === 'abort') abort.abort(); else current = 'https://other.example.test';
    respond(new Response(JSON.stringify(commit))); await rejected;
    expect(issued).toHaveBeenCalledExactlyOnceWith(commit);
  });

  it('observes cancellation during response decoding before rejecting', async () => {
    const abort = new AbortController(); const response = new Response('{}'); const issued = vi.fn();
    vi.spyOn(response, 'json').mockImplementation(async () => { abort.abort(); return commit; });
    const api = new SharedUnlockApi(vi.fn<typeof fetch>().mockResolvedValue(response), () => apiUrl);
    await expect(api.commit(apiUrl, 'operation', 'proof', abort.signal, issued)).rejects.toMatchObject({ code: 'cancelled' });
    expect(issued).toHaveBeenCalledExactlyOnceWith(commit);
  });
  it('never starts an already aborted commit or observes a failed response as a session', async () => {
    const abort = new AbortController(); abort.abort(); const issued = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(commit), { status: 401 }));
    const api = new SharedUnlockApi(fetcher, () => apiUrl);
    await expect(api.commit(apiUrl, 'operation', 'proof', abort.signal, issued)).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.commit(apiUrl, 'operation', 'proof', undefined, issued)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(issued).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not replay a lost commit body to recover its token', async () => {
    const response = new Response('{}'); vi.spyOn(response, 'json').mockRejectedValue(new Error('body lost'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response); const issued = vi.fn();
    const api = new SharedUnlockApi(fetcher, () => apiUrl);
    await expect(api.commit(apiUrl, 'operation', 'proof', undefined, issued)).rejects.toMatchObject({ code: 'network' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(issued).not.toHaveBeenCalled();
  });
  it('revokes only the captured new refresh lineage at the old origin after a server change', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const api = new SharedUnlockApi(fetcher, () => 'https://other.example.test');
    await api.revokeIssuedSession(apiUrl, { accessToken: 'synthetic-new-own-access', refreshToken: 'synthetic-new-own-refresh' });
    expect(fetcher).toHaveBeenCalledOnce(); const [url, init] = fetcher.mock.lastCall!;
    expect(url).toBe(apiUrl + '/api/auth/logout');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-new-own-access');
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'synthetic-new-own-refresh' });
  });
  it('bounds cleanup to two seconds even if transport ignores abort', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {}));
    const api = new SharedUnlockApi(fetcher, () => apiUrl);
    const cleanup = api.revokeIssuedSession(apiUrl, { accessToken: 'synthetic-new-own-access', refreshToken: 'synthetic-new-own-refresh' });
    await vi.advanceTimersByTimeAsync(2000); await cleanup;
    expect(fetcher.mock.lastCall![1]?.signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps cleanup best effort and does not retry a failed revocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-internal-error'));
    const api = new SharedUnlockApi(fetcher, () => apiUrl);
    await expect(api.revokeIssuedSession(apiUrl, { accessToken: 'synthetic-new-own-access', refreshToken: 'synthetic-new-own-refresh' })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
