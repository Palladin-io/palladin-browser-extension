import { describe, expect, it } from 'vitest';
import { ONE_CLICK_CHANNEL, isOneClickCommand, type OneClickCommand } from '@shared/messaging/one-click';
import type { ActiveTab } from '../vault/commands';
import { ENTRY_TYPE_CREDENTIAL, type EntryMetadata } from '../vault/entry-metadata';
import { OneClickRuns } from './one-click';

const DOC = 'a'.repeat(32);
const entry = { id: 'e1', vaultId: 'v1', type: ENTRY_TYPE_CREDENTIAL, name: 'AWS', username: 'ada', urlDomain: 'console.aws.amazon.com' } as EntryMetadata;
function setup(metadata: EntryMetadata[] = [entry]) {
  const reported: string[] = [];
  let now = 0, status: 'unlocked' | 'locked' = 'unlocked', next = 0;
  const runs = new OneClickRuns({ now: () => now, newId: () => `run-${++next}`, getStatus: async () => status, getMetadata: async () => metadata, reportMissingPrompt: url => { reported.push(url); } });
  const at = (url: string, id = 1): ActiveTab => ({ id, url, documentId: DOC, browserDocumentId: `d-${url}` });
  const send = (command: Record<string, unknown>, source: ActiveTab) =>
    runs.dispatch({ channel: ONE_CLICK_CHANNEL, documentId: DOC, ...command } as OneClickCommand, source);
  const start = async (url = 'https://console.aws.amazon.com/') => {
    const result = await send({ type: 'start', vaultId: 'v1', entryId: 'e1' }, at(url));
    if (result.status !== 'run') throw new Error(result.status);
    return result.run.runId;
  };
  return { reported, runs, at, send, start, advance: (ms: number) => { now += ms; }, lock: () => { status = 'locked'; } };
}
const HOME = 'https://console.aws.amazon.com/';
const SIGNIN = 'https://eu-north-1.signin.aws.amazon.com/oauth';

describe('one-click run authority', () => {
  it('starts only for a matching credential while unlocked', async () => {
    const t = setup();
    expect((await t.send({ type: 'start', vaultId: 'v1', entryId: 'e1' }, t.at('https://evil.example/'))).status).toBe('idle');
    expect((await t.send({ type: 'start', vaultId: 'v1', entryId: 'other' }, t.at(HOME))).status).toBe('idle');
    expect((await t.send({ type: 'start', vaultId: 'v1', entryId: 'e1' }, t.at('http://console.aws.amazon.com/'))).status).toBe('idle');
    t.lock();
    expect((await t.send({ type: 'start', vaultId: 'v1', entryId: 'e1' }, t.at(HOME))).status).toBe('idle');
  });
  it('follows one same-site host change before any value and then pins the host', async () => {
    const t = setup(); const runId = await t.start();
    expect(await t.send({ type: 'step', runId, stage: 'entry' }, t.at(HOME))).toEqual({ status: 'granted' });
    expect(await t.send({ type: 'resume' }, t.at(SIGNIN))).toMatchObject({ status: 'run', run: { match: 'related' } });
    expect(await t.send({ type: 'step', runId, stage: 'login' }, t.at(SIGNIN))).toEqual({ status: 'granted' });
    expect(await t.send({ type: 'resume' }, t.at('https://other.aws.amazon.com/'))).toEqual({ status: 'idle' });
    expect(await t.send({ type: 'step', runId, stage: 'totp' }, t.at(SIGNIN))).toEqual({ status: 'stopped' });
  });
  it('refuses a second host change', async () => {
    const t = setup(); await t.start();
    expect((await t.send({ type: 'resume' }, t.at(SIGNIN))).status).toBe('run');
    expect((await t.send({ type: 'resume' }, t.at('https://us-east-1.signin.aws.amazon.com/'))).status).toBe('idle');
  });
  it('never crosses to another site, even before a value', async () => {
    const t = setup(); await t.start();
    expect((await t.send({ type: 'resume' }, t.at('https://aws.evil.example/'))).status).toBe('idle');
    expect((await t.send({ type: 'resume' }, t.at(HOME))).status).toBe('idle');
  });
  it('grants each stage once, so a rejected password is never resubmitted', async () => {
    const t = setup(); const runId = await t.start();
    expect((await t.send({ type: 'step', runId, stage: 'identifier' }, t.at(HOME))).status).toBe('granted');
    expect((await t.send({ type: 'step', runId, stage: 'password' }, t.at(HOME))).status).toBe('granted');
    expect((await t.send({ type: 'step', runId, stage: 'password' }, t.at(HOME))).status).toBe('stopped');
    expect((await t.send({ type: 'step', runId, stage: 'totp' }, t.at(HOME))).status).toBe('stopped');
  });
  it('a combined form after a rejected password never submits that password again', async () => {
    const t = setup(); const runId = await t.start();
    expect((await t.send({ type: 'step', runId, stage: 'password' }, t.at(HOME))).status).toBe('granted');
    expect((await t.send({ type: 'step', runId, stage: 'login' }, t.at(HOME))).status).toBe('stopped');
    const second = await t.start();
    expect((await t.send({ type: 'step', runId: second, stage: 'identifier' }, t.at(HOME))).status).toBe('granted');
    expect((await t.send({ type: 'step', runId: second, stage: 'login' }, t.at(HOME))).status).toBe('granted');
  });
  it('a combined login also consumes identifier and password', async () => {
    const t = setup(); const runId = await t.start();
    await t.send({ type: 'step', runId, stage: 'login' }, t.at(HOME));
    expect((await t.send({ type: 'step', runId, stage: 'password' }, t.at(HOME))).status).toBe('stopped');
  });
  it('is bound to its tab and ends on timeout, lock, stop and tab close', async () => {
    const other = setup(); await other.start();
    expect((await other.send({ type: 'resume' }, other.at(HOME, 2))).status).toBe('idle');
    const late = setup(); await late.start(); late.advance(60_000);
    expect((await late.send({ type: 'resume' }, late.at(HOME))).status).toBe('idle');
    const locked = setup(); await locked.start(); locked.lock();
    expect((await locked.send({ type: 'resume' }, locked.at(HOME))).status).toBe('idle');
    const stopped = setup(); const runId = await stopped.start();
    await stopped.send({ type: 'stop', runId }, stopped.at(HOME));
    expect((await stopped.send({ type: 'resume' }, stopped.at(HOME))).status).toBe('idle');
    const closed = setup(); await closed.start(); closed.runs.clearTab(1);
    expect((await closed.send({ type: 'resume' }, closed.at(HOME))).status).toBe('idle');
    const relocked = setup(); await relocked.start(); relocked.runs.clear();
    expect((await relocked.send({ type: 'resume' }, relocked.at(HOME))).status).toBe('idle');
  });
  it('ignores a foreign run id', async () => {
    const t = setup(); await t.start();
    expect((await t.send({ type: 'step', runId: 'forged', stage: 'login' }, t.at(HOME))).status).toBe('stopped');
  });
});

describe('hidden prompt and missing-prompt report', () => {
  it('keeps a dismissed prompt hidden in that tab until the host changes', async () => {
    const t = setup();
    await t.send({ type: 'dismiss' }, t.at(HOME));
    expect((await t.send({ type: 'resume' }, t.at(`${HOME}other`))).status).toBe('hidden');
    expect((await t.send({ type: 'resume' }, t.at(HOME, 2))).status).toBe('idle');
    expect((await t.send({ type: 'resume' }, t.at(SIGNIN))).status).toBe('idle');
    expect((await t.send({ type: 'resume' }, t.at(HOME))).status).toBe('idle');
  });
  it('reports only a host with a saved entry while unlocked and not dismissed', async () => {
    const t = setup();
    await t.send({ type: 'prompt-missing' }, t.at('https://unrelated.example/'));
    expect(t.reported).toEqual([]);
    await t.send({ type: 'prompt-missing' }, t.at(HOME));
    expect(t.reported).toEqual([HOME]);
    await t.send({ type: 'dismiss' }, t.at(HOME));
    await t.send({ type: 'prompt-missing' }, t.at(HOME));
    t.lock();
    await t.send({ type: 'prompt-missing' }, t.at(HOME, 2));
    expect(t.reported).toEqual([HOME]);
  });
});

describe('one-click message guard', () => {
  const base = { channel: ONE_CLICK_CHANNEL, documentId: DOC };
  it('accepts only the exact vocabulary', () => {
    expect(isOneClickCommand({ ...base, type: 'resume' })).toBe(true);
    for (const bad of [null, {}, { ...base, type: 'resume', url: 'https://x' }, { ...base, type: 'step', runId: 'r', stage: 'register' },
      { ...base, type: 'start', vaultId: '', entryId: 'e' }, { ...base, documentId: 'short', type: 'resume' }, { ...base, channel: 'x', type: 'resume' }])
      expect(isOneClickCommand(bad)).toBe(false);
  });
});
