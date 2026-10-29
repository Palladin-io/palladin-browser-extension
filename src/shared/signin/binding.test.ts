import { currentVaultPlaintext } from '@palladin/crypto';
import { describe, expect, it } from 'vitest';
import { readSignInBinding, sameSignInAccount, SIGN_IN_FIELD_TYPE, withSignInBinding } from './binding';
import {
  isAuthorizationErrorReturn,
  providerForAuthorizationUrl,
} from './providers';

type MemberSecretV1 = currentVaultPlaintext.MemberSecretV1;

const otherFieldId = 'custom:11111111-1111-4111-8111-111111111111';

function credential(customFields: MemberSecretV1['content']['customFields'] = [], extraPolicy: Record<string, 'never'> = {}): MemberSecretV1 {
  return {
    schema: 'palladin.member-secret.v1', entryType: 'credential', memberLabel: 'Example', agentLabel: 'Example',
    discoverable: true, description: null, icon: null, color: null,
    agentFieldAccess: {
      memberLabel: 'never', agentLabel: 'discovery', description: 'never', icon: 'never', color: 'never',
      entryType: 'discovery', notes: 'onGrantValue', 'credential.username': 'discovery',
      'credential.urlDomain': 'discovery', 'credential.url': 'onGrantValue', 'credential.password': 'onGrantValue',
      'credential.totp': 'onGrantDerived', ...extraPolicy,
    },
    content: { username: '', password: '', url: 'https://example.com', urlDomain: 'example.com', totp: null, notes: null, customFields },
  } as MemberSecretV1;
}

const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
function nextId(): () => string { let index = 0; return () => ids[index++]!; }

describe('palladin.signin.v1 binding', () => {
  it('writes one canonical field with never Agent access that the shared parser accepts', () => {
    const next = withSignInBinding(credential(), { provider: 'google', account: '  alice@example.com ' }, 'Sign-in method', nextId());
    const bytes = currentVaultPlaintext.encodeMemberSecret(next);
    const parsed = currentVaultPlaintext.parseMemberSecret(bytes);
    expect(parsed.content.customFields).toEqual([{ id: `custom:${ids[0]}`, label: 'Sign-in method',
      type: SIGN_IN_FIELD_TYPE, value: { provider: 'google', account: 'alice@example.com' } }]);
    expect(parsed.agentFieldAccess[`custom:${ids[0]}`]).toBe('never');
    expect(readSignInBinding(parsed)).toEqual({ status: 'recognized', fieldId: `custom:${ids[0]}`,
      binding: { provider: 'google', account: 'alice@example.com' } });
    expect(JSON.stringify(currentVaultPlaintext.projectAgentDiscovery(parsed))).not.toContain('alice@example.com');
    expect(JSON.stringify(currentVaultPlaintext.projectMemberIndex(parsed))).not.toContain('alice@example.com');
  });

  it('the shared policy rejects exposing a sign-in field to Agents', () => {
    const next = withSignInBinding(credential(), { provider: 'apple', account: null }, 'Sign-in method', nextId());
    const unsafe = { ...next, agentFieldAccess: { ...next.agentFieldAccess, [`custom:${ids[0]}`]: 'onGrantValue' as const } };
    expect(() => currentVaultPlaintext.encodeMemberSecret(unsafe)).toThrow(/Unsafe AgentFieldAccess/);
  });

  it('replaces existing bindings, preserves unrelated fields and removes on null', () => {
    const other = { id: otherFieldId, label: 'Note', type: 'text', value: 'keep' };
    const first = withSignInBinding(credential([other], { [otherFieldId]: 'never' }),
      { provider: 'google', account: 'a@example.com' }, 'Sign-in method', nextId());
    const replaced = withSignInBinding(first, { provider: 'github', account: 'octo' }, 'Metoda logowania', () => ids[1]!);
    expect(replaced.content.customFields.map((field) => field.id)).toEqual([otherFieldId, `custom:${ids[1]}`]);
    expect(Object.keys(replaced.agentFieldAccess)).not.toContain(`custom:${ids[0]}`);
    expect(replaced.agentFieldAccess[otherFieldId]).toBe('never');
    const removed = withSignInBinding(replaced, null, '');
    expect(removed.content.customFields).toEqual([other]);
    expect(readSignInBinding(removed)).toEqual({ status: 'absent' });
    expect(() => currentVaultPlaintext.encodeMemberSecret(removed)).not.toThrow();
  });

  it.each([
    ['unknown provider', { provider: 'myspace', account: null }],
    ['extra keys', { provider: 'google', account: null, token: 'x' }],
    ['untrimmed account', { provider: 'google', account: ' a ' }],
    ['empty account', { provider: 'google', account: '' }],
    ['too long account', { provider: 'google', account: 'a'.repeat(257) }],
    ['string value', 'google:alice'],
  ])('treats %s as unrecognized', (_name, value) => {
    const secret = credential([{ id: `custom:${ids[0]}`, label: 'x', type: SIGN_IN_FIELD_TYPE, value: value as never }]);
    expect(readSignInBinding(secret)).toEqual({ status: 'unrecognized' });
  });

  it('reports two bindings as ambiguous and ignores other Entry types', () => {
    const field = (id: string) => ({ id: `custom:${id}`, label: 'x', type: SIGN_IN_FIELD_TYPE, value: { provider: 'google', account: null } });
    expect(readSignInBinding(credential([field(ids[0]!), field(ids[1]!)]))).toEqual({ status: 'ambiguous' });
    const key = { ...credential([field(ids[0]!)]), entryType: 'key' } as unknown as MemberSecretV1;
    expect(readSignInBinding(key)).toEqual({ status: 'absent' });
  });

  it('compares provider accounts case-insensitively but never across null', () => {
    expect(sameSignInAccount('Alice@Example.com', 'alice@example.com')).toBe(true);
    expect(sameSignInAccount('alice@example.com', 'bob@example.com')).toBe(false);
    expect(sameSignInAccount(null, 'alice@example.com')).toBe(false);
    expect(sameSignInAccount(null, null)).toBe(true);
  });
});

describe('provider authorization endpoints', () => {
  it.each([
    ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'google'],
    ['https://accounts.google.com/v3/signin/identifier?continue=x', 'google'],
    ['https://appleid.apple.com/auth/authorize?client_id=x', 'apple'],
    ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1', 'microsoft'],
    ['https://login.live.com/oauth20_authorize.srf?x=1', 'microsoft'],
    ['https://github.com/login/oauth/authorize?client_id=x', 'github'],
    ['https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize%3Fclient_id%3Dx', 'github'],
    ['https://www.facebook.com/v19.0/dialog/oauth?client_id=x', 'facebook'],
  ])('recognizes %s', (url, provider) => {
    expect(providerForAuthorizationUrl(url)).toBe(provider);
  });

  it.each([
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
    'https://accounts-google.com/o/oauth2/v2/auth',
    'https://evil.example/accounts.google.com/o/oauth2/v2/auth',
    'https://user:pass@accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com:8443/o/oauth2/v2/auth',
    'https://mail.google.com/mail',
    'https://github.com/login',
    'https://github.com/settings',
    'https://www.facebook.com/login.php',
    'not a url',
  ])('rejects %s', (url) => {
    expect(providerForAuthorizationUrl(url)).toBeNull();
  });

  it('detects only the standard OAuth error parameter on return', () => {
    expect(isAuthorizationErrorReturn('https://example.com/cb?error=access_denied&state=x')).toBe(true);
    expect(isAuthorizationErrorReturn('https://example.com/cb#error=user_cancelled_login')).toBe(true);
    expect(isAuthorizationErrorReturn('https://example.com/cb?code=abc&state=x')).toBe(false);
    expect(isAuthorizationErrorReturn('https://example.com/app')).toBe(false);
  });
});
