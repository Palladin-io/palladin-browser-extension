import { describe, expect, it, vi } from 'vitest'
import { SharedUnlockAuthorizationRetiredError, SharedUnlockExpiryStore } from './expiry-store'

const scope = { accountId: '11111111-1111-4111-8111-111111111111', apiUrl: 'https://api.example.test' }
function storage() {
  const values: Record<string, unknown> = {}
  return { values, get: vi.fn(async () => structuredClone(values)), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)) }) }
}
const make = (s: ReturnType<typeof storage>) => new SharedUnlockExpiryStore(s, action => action())

describe('own retired authorization sequence', () => {
  it('survives restart, is monotonic, and permits only a newer own authorization', async () => {
    const s = storage(), store = make(s)
    await Promise.all([store.advance(scope, 9), store.advance(scope, 4)])
    const restarted = make(s)
    await expect(restarted.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await expect(restarted.assertFresh(scope, 9)).rejects.toBeInstanceOf(SharedUnlockAuthorizationRetiredError)
    await expect(restarted.assertFresh(scope, 10)).resolves.toBeUndefined()
    expect(Object.values(s.values)).toEqual([{ version: 3, ...scope, throughSequence: 9, checkpoint: null }])
  })
  it('keeps different accounts and API environments independent', async () => {
    const store = make(storage()); await store.advance(scope, 9)
    await expect(store.assertFresh({ ...scope, apiUrl: 'https://other.example.test' }, 1)).resolves.toBeUndefined()
    await expect(store.assertFresh({ ...scope, accountId: '22222222-2222-4222-8222-222222222222' }, 1)).resolves.toBeUndefined()
  })
  it('retains failed persistence in RAM and repairs before accepting even a newer root', async () => {
    const s = storage(), store = make(s)
    s.set.mockRejectedValueOnce(new Error('disk unavailable')).mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(store.advance(scope, 9)).rejects.toThrow('disk unavailable')
    await expect(store.assertFresh(scope, 10)).rejects.toThrow('disk unavailable')
    await expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await expect(make(s).assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
  it('rejects corrupt or scope-substituted persisted bytes', async () => {
    const s = storage(), store = make(s); await store.advance(scope, 9)
    const key = Object.keys(s.values)[0]
    for (const value of [null, { version: 1, ...scope, throughSequence: -1 }, { version: 1, ...scope, apiUrl: 'https://other.example.test', throughSequence: 9 }]) {
      s.values[key] = value
      await expect(store.assertFresh(scope, 10)).rejects.toThrow('record unavailable')
    }
  })
  it('uses only the matching remembered own receipt and fences immediately before storage completes', async () => {
    const s = storage(), store = make(s)
    store.remember(scope, 9)
    store.retire({ ...scope, apiUrl: 'https://other.example.test' })
    await expect(store.assertFresh(scope, 9)).resolves.toBeUndefined()
    store.retire(scope)
    await expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
  it('fences retirement arriving while an earlier admission reads storage', async () => {
    const s = storage(), store = make(s)
    let release!: () => void
    s.get.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}) }))
    const admission = expect(store.assertFresh(scope, 9)).rejects.toThrow('retired locally')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const retirement = store.advance(scope, 9)
    release(); await admission; await retirement
    await expect(make(s).assertFresh(scope, 9)).rejects.toThrow('retired locally')
  })
})

describe('deadline retained while the client is closed', () => {
  it('permits reopening before the deadline without restarting the same authorization lifetime', async () => {
    const s = storage(); let now = 100;
    const first = new SharedUnlockExpiryStore(s, action => action(), () => now);
    expect(await first.checkpoint(scope, 5, 200)).toBe(200);
    now = 150;
    const restarted = new SharedUnlockExpiryStore(s, action => action(), () => now);
    expect(await restarted.checkpoint(scope, 5, 900)).toBe(200);
    now = 200;
    await expect(restarted.assertFresh(scope, 5)).rejects.toThrow('retired locally');
    now = 100;
    await expect(new SharedUnlockExpiryStore(s, action => action(), () => now).assertFresh(scope, 5)).rejects.toThrow('retired locally');
  });
  it('detects expiry after restart without any live timer or earlier expiry event', async () => {
    const s = storage();
    await new SharedUnlockExpiryStore(s, action => action(), () => 100).checkpoint(scope, 5, 200);
    const restarted = new SharedUnlockExpiryStore(s, action => action(), () => 200);
    await expect(restarted.checkpoint(scope, 5, 900)).rejects.toThrow('retired locally');
    expect(await restarted.checkpoint(scope, 6, 900)).toBe(900);
    await expect(restarted.assertFresh(scope, 5)).rejects.toThrow('retired locally');
  });
  it('never replaces a newer own authorization with an older live peer root', async () => {
    const store = new SharedUnlockExpiryStore(storage(), action => action(), () => 100);
    await store.checkpoint(scope, 6, 900);
    await expect(store.checkpoint(scope, 5, 200)).rejects.toThrow('retired locally');
    expect(await store.checkpoint(scope, 6, 1000)).toBe(900);
  });
  it('repairs a failed checkpoint write before permitting a later admission', async () => {
    const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    s.set.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(store.checkpoint(scope, 5, 200)).rejects.toThrow('disk unavailable');
    expect(await store.checkpoint(scope, 5, 900)).toBe(200);
    await expect(new SharedUnlockExpiryStore(s, action => action(), () => 200).assertFresh(scope, 5)).rejects.toThrow('retired locally');
  });
  it('keeps previously persisted v1 retirement barriers when upgrading the record', async () => {
    const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    s.values['palladin.shared-unlock.expiry.v1:' + JSON.stringify([scope.apiUrl, scope.accountId])] = { version: 1, ...scope, throughSequence: 4 };
    expect(await store.checkpoint(scope, 5, 200)).toBe(200);
    await expect(store.assertFresh(scope, 4)).rejects.toThrow('retired locally');
    expect(Object.values(s.values)).toEqual([{ version: 3, ...scope, throughSequence: 4, checkpoint: { sequence: 5, deadlineMs: 200, hardDeadlineMs: 200 } }]);
  });
  it('uses elapsed wall time again after a stalled successful storage write', async () => {
    const s = storage(); let now = 100;
    const save = s.set.getMockImplementation()!;
    s.set.mockImplementationOnce(async items => { await save(items); now = 200; });
    await expect(new SharedUnlockExpiryStore(s, action => action(), () => now).checkpoint(scope, 5, 200)).rejects.toThrow('retired locally');
    await expect(new SharedUnlockExpiryStore(s, action => action(), () => now).assertFresh(scope, 5)).rejects.toThrow('retired locally');
  });
});

describe('own activity renewal', () => {
  it('extends only idle, retaining the independent hard ceiling across later handoff', async () => {
    const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    await store.checkpoint(scope, 5, 200, 500);
    await store.renewOwn(scope, 5, 300, () => {});
    expect(await store.checkpoint(scope, 5, 900, 900)).toBe(300);
    await store.renewOwn(scope, 5, 900, () => {});
    expect(await store.checkpoint(scope, 5, 900, 900)).toBe(500);
    await expect(new SharedUnlockExpiryStore(s, action => action(), () => 500).assertFresh(scope, 5)).rejects.toThrow('retired locally');
  });
  it('cannot renew a retired, expired, missing or different own authorization', async () => {
    const s = storage(); let now = 100;
    const store = new SharedUnlockExpiryStore(s, action => action(), () => now);
    await expect(store.renewOwn(scope, 5, 300, () => {})).rejects.toThrow('checkpoint unavailable');
    await store.checkpoint(scope, 5, 200, 500);
    await expect(store.renewOwn(scope, 6, 300, () => {})).rejects.toThrow('checkpoint unavailable');
    await expect(store.renewOwn({ ...scope, apiUrl: 'https://other.example.test' }, 5, 300, () => {})).rejects.toThrow();
    now = 200;
    await expect(store.renewOwn(scope, 5, 300, () => {})).rejects.toThrow('retired locally');
    now = 100;
    await expect(store.renewOwn(scope, 5, 300, () => {})).rejects.toThrow('retired locally');
  });
  it('never queues a failed relaxation for automatic later repair', async () => {
    const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    await store.checkpoint(scope, 5, 200, 500);
    s.set.mockRejectedValueOnce(new Error('unavailable'));
    await expect(store.renewOwn(scope, 5, 300, () => {})).rejects.toThrow('unavailable');
    expect(await store.checkpoint(scope, 5, 400, 500)).toBe(200);
  });
  it('requires live independent own authority, never just a persisted checkpoint', async () => {
    const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    await store.checkpoint(scope, 5, 200, 500);
    const check = () => { throw new Error('own keys expired'); };
    expect(() => store.renewOwn(scope, 5, 300, check)).toThrow('own keys expired');
    expect(await store.checkpoint(scope, 5, 400, 500)).toBe(200);
  });
  it('does not invent a longer hard ceiling for a legacy v2 checkpoint', async () => {
    const s = storage();
    s.values['palladin.shared-unlock.expiry.v1:' + JSON.stringify([scope.apiUrl, scope.accountId])] = {
      version: 2, ...scope, throughSequence: 0, checkpoint: { sequence: 5, deadlineMs: 200 },
    };
    const store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
    await store.renewOwn(scope, 5, 400, () => {});
    expect(await store.checkpoint(scope, 5, 500, 900)).toBe(200);
    expect(await store.checkpoint(scope, 6, 500, 900)).toBe(500);
  });
});

it('rejects a persisted checkpoint whose idle deadline exceeds its recorded hard ceiling', async () => {
  const s = storage();
  s.values['palladin.shared-unlock.expiry.v1:' + JSON.stringify([scope.apiUrl, scope.accountId])] = {
    version: 3, ...scope, throughSequence: 0, checkpoint: { sequence: 5, deadlineMs: 400, hardDeadlineMs: 200 },
  };
  await expect(new SharedUnlockExpiryStore(s, action => action(), () => 300).assertFresh(scope, 5)).rejects.toThrow('record unavailable');
});

it('persists a closing that arrives while an own renewal write is in flight', async () => {
  const s = storage(), store = new SharedUnlockExpiryStore(s, action => action(), () => 100);
  await store.checkpoint(scope, 5, 200, 500);
  let release!: () => void;
  const save = s.set.getMockImplementation()!;
  s.set.mockImplementationOnce(async items => {
    await new Promise<void>(resolve => { release = resolve; });
    await save(items);
  });
  const renewing = expect(store.renewOwn(scope, 5, 300, () => {})).rejects.toThrow('retired locally');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const closing = store.advance(scope, 5);
  release(); await renewing; await closing;
  await expect(new SharedUnlockExpiryStore(s, action => action(), () => 100).assertFresh(scope, 5)).rejects.toThrow('retired locally');
});
