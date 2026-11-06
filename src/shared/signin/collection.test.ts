import { describe, expect, it } from 'vitest';
import { currentVaultPlaintext } from '@palladin/crypto';
import { readSignInMethods, mutateSignInMethod } from './binding';
const a = 'custom:AAAAAA11-1111-4111-8111-111111111111';
const b = 'custom:bbbbbb22-2222-4222-8222-222222222222';
const binding = { provider: 'google' as const, account: 'first@example.test', entry: null };
const opaque = { id: 'custom:cccccc33-3333-4333-8333-333333333333', label: 'Future', type: 'palladin.signin.v9', value: { future: true } };
function secret(): currentVaultPlaintext.MemberSecretV1 {
 return { entryType: 'credential', discoverable: true, agentFieldAccess: { [a]: 'never', [opaque.id]: 'never' }, content: { customFields: [{ id: a, label: 'Legacy', type: 'palladin.signin.v1', value: binding }, opaque] } } as unknown as currentVaultPlaintext.MemberSecretV1;
}
describe('lossless sign-in collection mutations', () => {
 it('appends same-provider accounts without changing legacy bytes, IDs, policies or opaque fields', () => {
  const before = secret();
  const next = mutateSignInMethod(before, null, { ...binding, account: 'second@example.test' }, 'Method', undefined, () => b.slice(7));
  expect(next.content.customFields.slice(0, 2)).toEqual(before.content.customFields);
  expect(next.content.customFields[2]).toMatchObject({ id: b, type: 'palladin.signin.v2' });
  expect(next.agentFieldAccess[a]).toBe('never');
  expect(readSignInMethods(next).map(method => method.id)).toEqual([a, b]);
 });
 it('edits and removes only the exact case-preserved stable ID', () => {
  const before = secret();
  const next = mutateSignInMethod(before, a, { ...binding, account: 'edited' }, 'Method');
  expect(next.content.customFields[0]).toMatchObject({ id: a, type: 'palladin.signin.v2' });
  expect(next.agentFieldAccess[a]).toBe('never');
  expect(next.content.customFields[1]).toEqual(opaque);
  expect(mutateSignInMethod(next, a, null, '').content.customFields).toEqual([opaque]);
  expect(() => mutateSignInMethod(next, a.toLowerCase(), null, '')).toThrow();
  expect(() => mutateSignInMethod(next, opaque.id, null, '')).toThrow();
 });
 it('rejects non-Credentials and malformed new values independently of UI', () => {
  expect(() => mutateSignInMethod({ ...secret(), entryType: 'key' } as never, null, binding, 'Method')).toThrow();
  expect(() => mutateSignInMethod(secret(), null, { ...binding, provider: 'unknown' } as never, 'Method')).toThrow();
 });
});
