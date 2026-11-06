import { describe, expect, it } from 'vitest';
import { InlineCaptureReviewSessions } from './inline-review';
import { INLINE_CAPTURE_REVIEW_CHANNEL as channel } from '../../shared/messaging/inline-capture-review';
import { NATIVE_LOGIN_CAPTURE_CHANNEL } from '../../shared/messaging/native-login-capture';
const sourceSender = { id: 'ext', tab: { id: 1 }, frameId: 0, documentId: 'top', url: 'https://example.com/', documentLifecycle: 'active' } as chrome.runtime.MessageSender;
const frame = { id: 'ext', tab: { id: 1 }, frameId: 2, documentId: 'frame', url: 'chrome-extension://ext/src/capture-review/index.html', documentLifecycle: 'active' } as chrome.runtime.MessageSender;
function setup() {
  let generation = 1, visible = true, live = true, now = 0;
  const owner = {}, port = {};
  const sessions = new InlineCaptureReviewSessions({ runtimeId: 'ext', frameUrl: frame.url!, now: () => now,
    sessionGeneration: () => generation, current: async () => live, attest: async () => visible,
    verifyFrameParent: async () => true, candidate: async () => true,
    dispatch: async () => ({ status: 'review', review: null }),
  });
  return { sessions, owner, port, setGeneration: () => { generation++; }, hide: () => { visible = false; }, navigate: () => { live = false; }, expire: () => { now = 180_001; } };
}
async function opened() {
  const f = setup();
  const capability = await f.sessions.mint(sourceSender, { kind: 'login', captureId: 'capture', documentId: 'isolated' }, f.owner);
  expect(capability).not.toBeNull();
  expect(await f.sessions.connect(capability!, frame, f.port)).toBe(true);
  const command = { channel, capability: capability!, kind: 'login', command: { channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type: 'get' } };
  return { ...f, capability: capability!, command };
}
describe('inline capture capability', () => {
  it('returns review only to its pinned iframe port', async () => {
    const f = await opened();
    expect(await f.sessions.dispatch(f.command, frame, {})).toEqual({ status: 'stale' });
    expect(await f.sessions.dispatch(f.command, frame, f.port)).toEqual({ status: 'review', review: null });
  });
  it.each(['tab', 'document', 'url', 'lifecycle', 'id', 'missing-document'] as const)('rejects changed iframe %s', async field => {
    const f = await opened();
    const changed = { ...frame, ...(field === 'tab' ? { tab: { id: 2 } } : field === 'document' ? { documentId: 'other' } : field === 'url' ? { url: 'chrome-extension://ext/src/popup/index.html' } : field === 'lifecycle' ? { documentLifecycle: 'cached' } : field === 'id' ? { id: 'other' } : { documentId: undefined }) } as chrome.runtime.MessageSender;
    expect(await f.sessions.dispatch(f.command, changed, f.port)).toEqual({ status: 'stale' });
  });
  it.each(['hide', 'navigate', 'setGeneration', 'expire'] as const)('revokes after %s', async action => {
    const f = await opened(); f[action]();
    expect(await f.sessions.dispatch(f.command, frame, f.port)).toEqual({ status: 'stale' });
  });
  it('rejects another capture and general privileged messages', async () => {
    const f = await opened();
    expect(await f.sessions.dispatch({ ...f.command, command: { channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type: 'dismiss', promptId: 'other', kind: 'credential' } }, frame, f.port)).toEqual({ status: 'stale' });
    expect(await f.sessions.dispatch({ ...f.command, command: { type: 'vault/reveal', entryId: 'any' } }, frame, f.port)).toEqual({ status: 'stale' });
  });
  it('rejects replay connection and revokes on owner disconnect', async () => {
    const f = await opened();
    expect(await f.sessions.connect(f.capability, { ...frame, frameId: 3 }, {})).toBe(false);
    f.sessions.revokeOwner(f.owner);
    expect(await f.sessions.dispatch(f.command, frame, f.port)).toEqual({ status: 'stale' });
  });
  it('does not mint for child frames or browsers without document identity', async () => {
    const f = setup();
    for (const sender of [{ ...sourceSender, frameId: 1 }, { ...sourceSender, documentId: undefined }]) {
      expect(await f.sessions.mint(sender, { kind: 'login', captureId: 'capture', documentId: 'isolated' }, f.owner)).toBeNull();
    }
  });
});

it('does not mint a capability after the initiating port disconnects during attestation', async () => {
  let resolve!: (value: boolean) => void;
  const owner = {};
  const sessions = new InlineCaptureReviewSessions({ runtimeId: 'ext', frameUrl: frame.url!, sessionGeneration: () => 1,
    current: async () => true, candidate: async () => true, verifyFrameParent: async () => true,
    attest: () => new Promise<boolean>(done => { resolve = done; }), dispatch: async () => ({ status: 'stale' }),
  });
  const pending = sessions.mint(sourceSender, { kind: 'login', captureId: 'capture', documentId: 'isolated' }, owner);
  await Promise.resolve(); await Promise.resolve();
  sessions.revokeOwner(owner); resolve(true);
  expect(await pending).toBeNull();
});

it.each(['moz-extension:', 'safari-web-extension:'])('uses real document identities on %s even when lifecycle is omitted', async scheme => {
  const frameUrl = `${scheme}//ext/src/capture-review/index.html`;
  const sessions = new InlineCaptureReviewSessions({runtimeId:'ext',frameUrl,sessionGeneration:()=>1,current:async()=>true,
    candidate:async()=>true,attest:async()=>true,verifyFrameParent:async()=>true,dispatch:async()=>({status:'stale'})});
  const capability = await sessions.mint({...sourceSender,documentLifecycle:undefined},{kind:'login',captureId:'capture',documentId:'isolated'},{});
  expect(capability).not.toBeNull();
  expect(await sessions.connect(capability!,{...frame,url:frameUrl,documentLifecycle:undefined},{})).toBe(true);
  const missing = await sessions.mint({...sourceSender,documentId:undefined,documentLifecycle:undefined},{kind:'login',captureId:'capture',documentId:'isolated'},{});
  expect(missing).toBeNull();
});

it('retains only exact save receipt navigation authority and denies subsequent reads or arbitrary IDs', async () => {
  const opened: unknown[]=[];
  const sessions=new InlineCaptureReviewSessions({runtimeId:'ext',frameUrl:frame.url!,sessionGeneration:()=>1,current:async()=>true,candidate:async()=>true,attest:async()=>true,verifyFrameParent:async()=>true,
    dispatch:async()=>({status:'saved',vaultId:'saved-vault',entryId:'saved-entry'}),navigateSaved:async receipt=>{opened.push(receipt);return true;}});
  const port={};
  const capability=(await sessions.mint(sourceSender,{kind:'login',captureId:'capture',documentId:'isolated'},{}))!;
  await sessions.connect(capability,frame,port);
  const envelope={channel,capability,kind:'login',command:{channel:NATIVE_LOGIN_CAPTURE_CHANNEL,type:'get'}};
  expect(await sessions.dispatch(envelope,frame,port)).toMatchObject({status:'saved'});
  expect(await sessions.dispatch(envelope,frame,port)).toEqual({status:'stale'});
  expect(await sessions.dispatch({...envelope,command:{type:'open-saved',entryId:'other'}},frame,port)).toEqual({status:'stale'});
  expect(await sessions.dispatch({...envelope,command:{type:'open-saved'}},frame,port)).toEqual({status:'dismissed'});
  expect(opened).toEqual([{vaultId:'saved-vault',entryId:'saved-entry'}]);
  expect(await sessions.dispatch({...envelope,command:{type:'open-saved'}},frame,port)).toEqual({status:'stale'});
});

it('binds legacy Firefox to an explicit current capture route and exact iframe Port without inventing browser document IDs',async()=>{
  let current=true;
  const frameUrl='moz-extension://ext/src/capture-review/index.html';
  const sessions=new InlineCaptureReviewSessions({runtimeId:'ext',frameUrl,sessionGeneration:()=>1,
    resolveSource:async()=>({tabId:1,frameId:0,documentId:'isolated',url:sourceSender.url!,legacyRouteId:'route',legacyTopRouteId:'route'}),
    current:async()=>current,candidate:async()=>true,attest:async()=>true,verifyFrameParent:async()=>current,dispatch:async()=>({status:'review',review:null})});
  const sender={...sourceSender,documentId:undefined,documentLifecycle:undefined};
  const capability=(await sessions.mint(sender,{kind:'login',captureId:'capture',documentId:'isolated'},{}))!;
  expect(capability).not.toBeNull();
  const child={...frame,url:frameUrl,documentId:undefined,documentLifecycle:undefined},port={};
  expect(await sessions.connect(capability,child,port)).toBe(true);
  const command={channel,capability,kind:'login',command:{channel:NATIVE_LOGIN_CAPTURE_CHANNEL,type:'get'}};
  expect(await sessions.dispatch(command,child,{})).toEqual({status:'stale'});
  expect(await sessions.dispatch(command,child,port)).toEqual({status:'review',review:null});
  current=false;
  expect(await sessions.dispatch(command,child,port)).toEqual({status:'stale'});
});

it('hands off edited draft without writes and survives intentional iframe teardown, then consumes once',async()=>{
 const draft={kind:'totp' as const,targetId:'target',label:'Edited draft',username:'account',replace:false,confirmDomainMismatch:false};
 let writes=0;
 const sessions=new InlineCaptureReviewSessions({runtimeId:'ext',frameUrl:frame.url!,sessionGeneration:()=>1,current:async()=>true,candidate:async()=>true,attest:async()=>true,verifyFrameParent:async()=>true,dispatch:async()=>{writes++;return {status:'saved'};},navigateDraft:async()=>true});
 const owner={},port={};const capability=(await sessions.mint(sourceSender,{kind:'totp',captureId:'capture',documentId:'isolated'},owner))!;
 await sessions.connect(capability,frame,port);
 expect(await sessions.dispatch({channel,capability,kind:'totp',command:{type:'open-draft',draft}},frame,port)).toEqual({status:'dismissed'});
 sessions.revokeOwner(port);sessions.revokeOwner(owner);
 expect(await sessions.takeDraft('totp','capture')).toEqual(draft);
 expect(await sessions.takeDraft('totp','capture')).toBeNull();
 expect(writes).toBe(0);sessions.clear();
});

it.each(['lock','navigation','expiry','source'] as const)('drops transferred draft after %s',async invalidation=>{
 let now=0,generation=1,current=true;
 const sessions=new InlineCaptureReviewSessions({runtimeId:'ext',frameUrl:frame.url!,now:()=>now,sessionGeneration:()=>generation,current:async()=>current,candidate:async()=>true,attest:async()=>true,verifyFrameParent:async()=>true,dispatch:async()=>({status:'stale'}),navigateDraft:async()=>true});
 const owner={},port={};const capability=(await sessions.mint(sourceSender,{kind:'totp',captureId:'capture',documentId:'isolated'},owner))!;
 await sessions.connect(capability,frame,port);
 await sessions.dispatch({channel,capability,kind:'totp',command:{type:'open-draft',draft:{kind:'totp',targetId:'target',label:'Edited draft',username:'',replace:false,confirmDomainMismatch:false}}},frame,port);
 if(invalidation==='lock'){generation++;sessions.clear();}else if(invalidation==='navigation')sessions.revokeTab(1);else if(invalidation==='expiry')now=180001;else current=false;
 expect(await sessions.takeDraft('totp','capture')).toBeNull();sessions.clear();
});
