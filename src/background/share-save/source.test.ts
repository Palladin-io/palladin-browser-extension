import { describe, expect, it } from 'vitest';
import { shareSource } from './source';
import type { Connection } from '../../shared/config/connection';

const active: Connection = { name: 'Self hosted', apiUrl: 'https://api.example.test', webUrl: 'https://panel.example.test', allowHttp: false, sharedUnlockEnabled: false };
const sender = { id: 'own', frameId: 0, tab: { id: 1, incognito: false }, documentId: 'current',
  origin: active.webUrl, url: active.webUrl + '/share/11111111-1111-4111-8111-111111111111' } as chrome.runtime.MessageSender;
describe('share-save active connection authority', () => {
  it('accepts the independently configured panel even when shared unlock is OFF', () => {
    expect(shareSource(sender, 'own', () => 'current', active)).toMatchObject({ apiUrl: active.apiUrl, webOrigin: active.webUrl });
  });
  it('rejects the previous panel after replacement and an unconfigured profile', () => {
    expect(shareSource(sender, 'own', () => 'current', { ...active, webUrl: 'https://other.example.test' })).toBeNull();
    expect(shareSource(sender, 'own', () => 'current', undefined)).toBeNull();
  });
  it('retains independent browser origin, document, top-frame and sender checks', () => {
    for (const changes of [{ origin: 'https://other.example.test' }, { documentId: 'stale' }, { frameId: 1 }, { id: 'other' }]) {
      expect(shareSource({ ...sender, ...changes }, 'own', () => 'current', active)).toBeNull();
    }
  });
});
