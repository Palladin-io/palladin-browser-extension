import { describe, expect, it, vi } from 'vitest';
import { createInlineCaptureReviewRuntime, INLINE_REVIEW_OWNER_PORT, INLINE_REVIEW_FRAME_PORT, validInlineReviewGesture, verifyInlineReviewFrame } from './inline-review-runtime';
const sender = { id: 'ext', tab: { id: 1 }, frameId: 0, documentId: 'top', url: 'https://example.com/', documentLifecycle: 'active' } as chrome.runtime.MessageSender;
function port(name: string, identity = sender) {
  const messages: unknown[] = [];
  const messageListeners: Array<(raw: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const p = { name, sender: identity, postMessage: (raw: unknown) => { messages.push(raw); }, disconnect: vi.fn(),
    onMessage: { addListener: (fn: (raw: unknown) => void) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) } } as unknown as chrome.runtime.Port;
  return { p, messages, emit: (raw: unknown) => messageListeners.forEach(fn => fn(raw)), close: () => disconnectListeners.forEach(fn => fn()) };
}
function runtime() {
  return createInlineCaptureReviewRuntime({ apiUrl: () => 'https://api.example.test', runtimeId: 'ext', frameUrl: 'chrome-extension://ext/src/capture-review/index.html',
    sessionGeneration: () => 1, current: async () => true, verifyFrameParent: async () => true, candidate: async () => true,
    dispatch: async () => ({ status: 'stale' }), withOperation: async operation => operation(), onSaved: () => {},
  });
}
describe('inline review port transport', () => {
  it('rejects owner ports without a browser-authenticated top document', () => {
    const r = runtime(); const p = port(INLINE_REVIEW_OWNER_PORT, { ...sender, frameId: 2 });
    expect(r.connect(p.p)).toBe(true); expect(p.p.disconnect).toHaveBeenCalled();
  });
  it('does not grant until the owning isolated port answers its unpredictable challenge', async () => {
    const r = runtime(); const p = port(INLINE_REVIEW_OWNER_PORT); r.connect(p.p);
    p.emit({ type: 'mint', kind: 'login', captureId: 'capture', documentId: 'isolated' });
    await vi.waitFor(() => expect(p.messages.length).toBe(1));
    const challenge = p.messages[0] as { requestId: string };
    p.emit({ type: 'attested', requestId: 'forged', ok: true });
    await Promise.resolve(); expect(p.messages.length).toBe(1);
    p.emit({ type: 'attested', requestId: challenge.requestId, ok: true });
    await vi.waitFor(() => expect(p.messages[1]).toMatchObject({ type: 'minted', capability: expect.any(String) })); r.clear();
  });
  it('rejects a frame command before a successful capability connection', async () => {
    const r = runtime(); const p = port(INLINE_REVIEW_FRAME_PORT); r.connect(p.p);
    p.emit({ type: 'command', requestId: 'r', envelope: {} });
    await vi.waitFor(() => expect(p.messages[0]).toEqual({ type: 'result', requestId: 'r', result: { status: 'stale' } }));
  });
  it('requires a recent finite trusted-action descriptor for mutations', () => {
    expect(validInlineReviewGesture({ x: 10, y: 20, keyboard: false, at: 1000 }, 1100)).toBe(true);
    for (const gesture of [undefined, {x: NaN,y:20,keyboard:false,at:1000}, {x:10,y:20,keyboard:false,at:0}, {x:10,y:20,keyboard:false,at:5000}]) {
      expect(validInlineReviewGesture(gesture, 2000)).toBe(false);
    }
  });
});

it('routes a review only to its iframe and rejects a save without a fresh local gesture', async () => {
  let writes = 0, saved = 0;
  const r = createInlineCaptureReviewRuntime({ apiUrl: () => 'https://api.example.test', runtimeId: 'ext', frameUrl: 'chrome-extension://ext/src/capture-review/index.html',
    sessionGeneration: () => 1, current: async () => true, verifyFrameParent: async () => true, candidate: async () => true,
    dispatch: async command => {
      if (command.command.type === 'save') { writes++; return { status: 'saved' }; }
      return { status: 'review', review: null };
    }, withOperation: async operation => operation(), onSaved: () => { saved++; },
  });
  const owner = port(INLINE_REVIEW_OWNER_PORT);
  const ownerPost = owner.p.postMessage;
  owner.p.postMessage = message => {
    ownerPost(message);
    const value = message as { type: string; requestId: string };
    if (value.type === 'attest') queueMicrotask(() => owner.emit({ type: 'attested', requestId: value.requestId, ok: true }));
  };
  r.connect(owner.p); owner.emit({ type: 'mint', kind: 'login', captureId: 'capture', documentId: 'isolated' });
  await vi.waitFor(() => expect(owner.messages.some(message => (message as {type:string}).type === 'minted')).toBe(true));
  const capability = (owner.messages.find(message => (message as {type:string}).type === 'minted') as {capability:string}).capability;
  const child = port(INLINE_REVIEW_FRAME_PORT, { ...sender, frameId: 2, documentId: 'child', url: 'chrome-extension://ext/src/capture-review/index.html' });
  const childPost = child.p.postMessage;
  child.p.postMessage = message => {
    childPost(message);
    const value = message as {type:string;requestId:string;nonce:string};
    if (value.type === 'binding-challenge') queueMicrotask(() => owner.emit({type:'binding-proof',requestId:value.requestId,nonce:value.nonce}));
  };
  r.connect(child.p); child.emit({ type: 'connect', capability });
  await vi.waitFor(() => expect(child.messages).toContainEqual({ type: 'connected', ok: true, apiUrl: 'https://api.example.test' }));
  const envelope = { channel: 'palladin.inline-capture-review.v1', capability, kind: 'login', command: { channel: 'palladin.native-login-capture', type: 'get' } };
  child.emit({ type: 'command', requestId: 'read', envelope });
  await vi.waitFor(() => expect(child.messages).toContainEqual({ type: 'result', requestId: 'read', result: {status:'review',review:null} }));
  const saveEnvelope = { ...envelope, command: { channel: 'palladin.native-login-capture', type: 'save', promptId: 'capture', targetId: 'target', autoUpdate: false,
    entry: { entryType: 'credential', label: 'Synthetic', username: 'synthetic', password: 'synthetic', url: 'https://example.com' } } };
  child.emit({ type: 'command', requestId: 'no-gesture', envelope: saveEnvelope });
  await vi.waitFor(() => expect(child.messages).toContainEqual({ type: 'result', requestId: 'no-gesture', result: {status:'stale'} }));
  expect(writes).toBe(0);
  child.emit({ type: 'command', requestId: 'save', envelope: saveEnvelope, gesture: { x: 10, y: 20, keyboard: false, at: Date.now() } });
  await vi.waitFor(() => expect(child.messages).toContainEqual({ type: 'result', requestId: 'save', result: {status:'saved'} }));
  expect(writes).toBe(1); expect(saved).toBe(1);
  expect(owner.messages.every(message => (message as {type:string}).type !== 'result')).toBe(true);
  r.clear();
});

it('rejects a replayed binding proof for a later operation and never sends its nonce to the owner', async () => {
  const r = runtime();
  const owner = port(INLINE_REVIEW_OWNER_PORT);
  const ownerPost = owner.p.postMessage;
  owner.p.postMessage = message => {
    ownerPost(message);
    const value = message as {type:string;requestId:string};
    if (value.type === 'attest') queueMicrotask(() => owner.emit({type:'attested',requestId:value.requestId,ok:true}));
  };
  r.connect(owner.p); owner.emit({type:'mint',kind:'login',captureId:'capture',documentId:'isolated'});
  await vi.waitFor(() => expect(owner.messages.some(message => (message as {type:string}).type === 'minted')).toBe(true));
  const capability = (owner.messages.find(message => (message as {type:string}).type === 'minted') as {capability:string}).capability;
  const child = port(INLINE_REVIEW_FRAME_PORT,{...sender,frameId:2,documentId:'child',url:'chrome-extension://ext/src/capture-review/index.html'});
  const childPost = child.p.postMessage;
  let oldNonce: string | undefined;
  child.p.postMessage = message => {
    childPost(message);
    const value = message as {type:string;requestId:string;nonce:string};
    if (value.type === 'binding-challenge') {
      const nonce = oldNonce ?? value.nonce;
      oldNonce = value.nonce;
      queueMicrotask(() => owner.emit({type:'binding-proof',requestId:value.requestId,nonce}));
    }
  };
  r.connect(child.p); child.emit({type:'connect',capability});
  await vi.waitFor(() => expect(child.messages).toContainEqual({type:'connected',ok:true,apiUrl:'https://api.example.test'}));
  child.emit({type:'command',requestId:'read',envelope:{channel:'palladin.inline-capture-review.v1',capability,kind:'login',command:{channel:'palladin.native-login-capture',type:'get'}}});
  await vi.waitFor(() => expect(child.messages).toContainEqual({type:'result',requestId:'read',result:{status:'stale'}}));
  expect(owner.messages.every(message => !('nonce' in (message as object)))).toBe(true);
  r.clear();
});

it.each(['chrome-extension:', 'moz-extension:', 'safari-web-extension:'])('checks independent current top identity for %s without relying on hidden extension child enumeration', async scheme => {
  const top = {documentId:'top',parentFrameId:-1,url:'https://example.com/',documentLifecycle:scheme === 'chrome-extension:' ? 'active' : undefined};
  const tab: {id:number;incognito:boolean;status:string;url:string|undefined} = {id:1,incognito:false,status:'complete',url:top.url};
  vi.stubGlobal('chrome',{webNavigation:{getFrame:vi.fn(async()=>top)},tabs:{get:vi.fn(async()=>tab)}});
  try {
    const child = {...sender,frameId:2,documentId:'child',url:`${scheme}//ext/src/capture-review/index.html`};
    const source = {tabId:1,frameId:0,browserDocumentId:'top',topDocumentId:'top',documentId:'isolated',url:top.url};
    expect(await verifyInlineReviewFrame(child,source)).toBe(true);
    tab.url=undefined;
    expect(await verifyInlineReviewFrame(child,source)).toBe(true);
    tab.url='https://different.example/';
    expect(await verifyInlineReviewFrame(child,source)).toBe(false);
    tab.url=top.url;
    top.documentId='navigated';
    expect(await verifyInlineReviewFrame(child,source)).toBe(false);
    top.documentId='top';tab.status='loading';
    expect(await verifyInlineReviewFrame(child,source)).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});

it('denies handoff plaintext retrieval to content and embedded extension frames',async()=>{
 const r=runtime();
 const request={channel:'palladin.capture-draft.v1',kind:'login',id:'capture'};
 expect(await r.readDraft(request,sender)).toEqual({draft:null});
 expect(await r.readDraft(request,{...sender,url:'chrome-extension://ext/src/capture-review/index.html',frameId:2})).toEqual({draft:null});
 r.clear();
});
