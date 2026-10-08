import { describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from './service';

const vaultId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
function setup() {
  let keys: object | null = {};
  let apiUrl = 'https://example.test';
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ items: [], nextCursor: null }));
  const session = {
    getKeys: () => keys,
    getAccessToken: vi.fn(async () => 'test-token'),
    refreshAccessToken: vi.fn(async () => 'fresh-test-token'),
  };
  const service = new WorkspaceService({
    session,
    apiUrl: () => apiUrl,
    fetch,
  });
  return {
    service,
    fetch,
    session,
    lock: () => {
      keys = null;
      service.lock();
    },
    switchServer: () => {
      apiUrl = 'https://other.test';
    },
  };
}

describe('workspace command boundary', () => {
  it('rejects arbitrary paths and unknown operations without fetching', async () => {
    const { service, fetch } = setup();
    expect(
      await service.handle({ type: 'workspace/fetch', path: '/api/admin' }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(
      await service.handle({ type: 'workspace/grants', path: '/api/admin' }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(
      await service.handle({
        type: 'workspace/revoke-grant',
        vaultId: '../admin',
        grantId,
      }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves forward-compatible server rows and encodes the cursor', async () => {
    const { service, fetch } = setup();
    const page = {
      items: [{ id: grantId, status: 'future-status' }],
      nextCursor: null,
    };
    fetch.mockResolvedValue(Response.json(page));
    expect(
      await service.handle({
        type: 'workspace/grants',
        cursor: 'a&status=active',
      }),
    ).toEqual({ ok: true, data: page });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('cursor')).toBe('a&status=active');
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('sends denial only to its scoped endpoint', async () => {
    const { service, fetch } = setup();
    expect(
      await service.handle({
        type: 'workspace/deny',
        vaultId,
        grantId,
        reason: '  denied  ',
      }),
    ).toEqual({ ok: true, data: null });
    expect(fetch).toHaveBeenCalledWith(
      `https://example.test/api/vaults/${vaultId}/grants/${grantId}/deny`,
      expect.objectContaining({
        method: 'PUT',
        body: '{"reason":"denied"}',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      }),
    );
  });

  it('does not advertise JSON for bodyless workspace requests', async () => {
    const { service, fetch } = setup();
    for (const command of [
      { type: 'workspace/grants' }, { type: 'workspace/grant-summary' },
      { type: 'workspace/audit' }, { type: 'workspace/members' },
      { type: 'workspace/shares', vaultId, entryId: grantId },
      { type: 'workspace/revoke-share', vaultId, entryId: grantId, shareId: grantId },
    ]) {
      await service.handle(command);
      const init = fetch.mock.calls.at(-1)![1]!;
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('content-type')).toBe(false);
    }
  });

  it('declares JSON when sending a mutation payload', async () => {
    const { service, fetch } = setup();
    await service.handle({ type: 'workspace/deny', vaultId, grantId });
    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('reports HTTP failures without exposing the response body', async () => {
    const { service, fetch } = setup();
    fetch.mockResolvedValue(new Response('private server details', { status: 403 }));
    expect(await service.handle({ type: 'workspace/audit' })).toEqual({
      ok: false, code: 'forbidden', httpStatus: 403,
    });
  });

  it('distinguishes transport failure from unreadable responses', async () => {
    const { service, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('private network details'));
    expect(await service.handle({ type: 'workspace/grants' })).toEqual({ ok: false, code: 'transport' });
    fetch.mockResolvedValueOnce(new Response('not json'));
    expect(await service.handle({ type: 'workspace/audit' })).toEqual({ ok: false, code: 'response', httpStatus: 200 });
  });

  it('deserializes JSON even when the server omits its content type', async () => {
    const { service, fetch } = setup();
    const page = { items: [], nextCursor: null };
    fetch.mockResolvedValue(new Response(JSON.stringify(page)));
    expect(await service.handle({ type: 'workspace/grants' })).toEqual({ ok: true, data: page });
  });

  it('identifies session access and refresh failures without exposing their messages', async () => {
    const { service, fetch, session } = setup();
    session.getAccessToken.mockRejectedValueOnce(new Error('private session details'));
    expect(await service.handle({ type: 'workspace/audit' })).toEqual({ ok: false, code: 'session' });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    session.refreshAccessToken.mockRejectedValueOnce(new Error('private refresh details'));
    expect(await service.handle({ type: 'workspace/grants' })).toEqual({ ok: false, code: 'refresh', httpStatus: 401 });
  });

  it('never fetches with a locked session', async () => {
    const { service, fetch, lock } = setup();
    lock();
    expect(await service.handle({ type: 'workspace/audit' })).toEqual({
      ok: false,
      code: 'locked',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts pending work and suppresses a late response after locking', async () => {
    const { service, fetch, lock } = setup();
    let resolve!: (response: Response) => void;
    fetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = service.handle({ type: 'workspace/members' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    lock();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve(
      Response.json({
        items: [{ userId: grantId, displayName: 'Synthetic member' }],
      }),
    );
    expect(await result).toEqual({ ok: false, code: 'locked' });
  });

  it('suppresses a response if the configured server changes', async () => {
    const { service, fetch, switchServer } = setup();
    fetch.mockImplementation(async () => {
      switchServer();
      return Response.json({ items: [] });
    });
    expect(await service.handle({ type: 'workspace/grants' })).toEqual({
      ok: false,
      code: 'locked',
    });
  });

  it('refreshes once after unauthorized, without leaking tokens in the reply', async () => {
    const { service, fetch, session } = setup();
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
    expect(await service.handle({ type: 'workspace/grants' })).toEqual({
      ok: true,
      data: { items: [], nextCursor: null },
    });
    expect(session.refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it.each(['session', 'server'])('does not route an old mutation after %s changes during action dispatch', async change => {
  let keys = {}, apiUrl = 'https://example.test';
  let finish!: (value: null) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const service = new WorkspaceService({
    session: { getKeys: () => keys, getAccessToken: async () => 'test-token', refreshAccessToken: async () => null },
    apiUrl: () => apiUrl, fetch,
    actions: { handle: () => new Promise<null>(resolve => { finish = resolve; }), clear() {} },
  });
  const result = service.handle({ type: 'workspace/revoke-grant', vaultId, grantId });
  if (change === 'session') keys = {};
  else apiUrl = 'https://other.test';
  finish(null);
  expect(await result).toEqual({ ok: false, code: 'locked' });
  expect(fetch).not.toHaveBeenCalled();
});
