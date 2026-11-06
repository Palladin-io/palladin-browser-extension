import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ nativeReview: vi.fn(), nativeSave: vi.fn(), dispatch: vi.fn(), federated: vi.fn(), document: vi.fn(), icon: vi.fn() }));
vi.mock('./credential-runtime', () => ({ credentialCaptureCoordinator: { nativeReview: mocks.nativeReview, nativeSave: mocks.nativeSave, dispatch: mocks.dispatch } }));
vi.mock('../signin/runtime', () => ({ federatedSignIn: { dispatch: mocks.federated } }));
vi.mock('../vault/runtime', () => ({ credentialWriter: { captureIcon: mocks.icon } }));
vi.mock('../tab-documents', () => ({ browserDocumentIdForTab: mocks.document }));
import { dispatchNativeLoginCapture } from './native-login';
import { NATIVE_LOGIN_CAPTURE_CHANNEL as channel } from '../../shared/messaging/native-login-capture';
const sender = { id: 'extension', url: 'chrome-extension://extension/popup.html' };
const origin = 'chrome-extension://extension/';
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
function runtime() {
  mocks.document.mockReturnValue('browser-document');
  const sendMessage = vi.fn(async () => ({ url: 'https://accounts.example.com', documentId: 'a'.repeat(32) }));
  vi.stubGlobal('chrome', { windows: { getLastFocused: async () => ({ id: 7 }) }, tabs: { query: async () => [{ id: 1, windowId: 7 }], sendMessage } });
  return sendMessage;
}
describe('native login capture authorization', () => {
  it('rejects page and other-extension callers before accessing tabs or plaintext', () => {
    expect(dispatchNativeLoginCapture({ channel, type: 'get' }, { ...sender, tab: { id: 1 } }, 'extension', origin)).toBeNull();
    expect(dispatchNativeLoginCapture({ channel, type: 'get' }, { ...sender, id: 'other' }, 'extension', origin)).toBeNull();
    expect(mocks.nativeReview).not.toHaveBeenCalled();
  });
  it('binds the native review to the current browser and isolated-world document', async () => {
    const sendMessage = runtime();
    mocks.nativeReview.mockResolvedValue({ prompt: { id: 'capture' }, entry: { password: 'synthetic-secret' } });
    const result = await dispatchNativeLoginCapture({ channel, type: 'get' }, sender, 'extension', origin);
    expect(result).toMatchObject({ status: 'review', review: { kind: 'credential' } });
    expect(sendMessage).toHaveBeenCalledWith(1, expect.anything(), { documentId: 'browser-document' });
    expect(mocks.nativeReview).toHaveBeenCalledWith({ tabId: 1, browserDocumentId: 'browser-document', documentId: 'a'.repeat(32), url: 'https://accounts.example.com' }, undefined);
  });
  it('rejects navigation during current-document lookup before requesting a draft', async () => {
    runtime();
    mocks.document.mockReturnValueOnce('old-document').mockReturnValue('new-document');
    expect(await dispatchNativeLoginCapture({ channel, type: 'get' }, sender, 'extension', origin)).toEqual({ status: 'stale' });
    expect(mocks.nativeReview).not.toHaveBeenCalled();
  });
  it('requires replacement approval for a different remembered provider', async () => {
    runtime();
    mocks.federated.mockResolvedValue({ status: 'prompt', prompt: { id: 'prompt', provider: 'google',
      targets: [{ id: 'target', current: { provider: 'apple', account: 'old@example.com' } }],
      accounts: [{ id: 'account', source: 'vault', label: 'new@example.com' }] } });
    const command = { channel, type: 'confirm', promptId: 'prompt', targetId: 'target', accountId: 'account', locale: 'en', replace: false };
    expect(await dispatchNativeLoginCapture(command, sender, 'extension', origin)).toEqual({ status: 'stale' });
    expect(mocks.federated).toHaveBeenCalledTimes(1);
  });
});

it('never applies a new-entry name to an existing OAuth target', async () => {
 runtime();mocks.federated.mockResolvedValue({status:'prompt',prompt:{id:'p',provider:'google',targets:[{id:'t',action:'update',current:null}],accounts:[{id:'a',source:'none',label:''}]}});
 expect(await dispatchNativeLoginCapture({channel,type:'confirm',promptId:'p',targetId:'t',accountId:'a',locale:'en',replace:false,entryName:'Rename attack'},sender,'extension',origin)).toEqual({status:'stale'});
 expect(mocks.federated).toHaveBeenCalledTimes(1);
});
