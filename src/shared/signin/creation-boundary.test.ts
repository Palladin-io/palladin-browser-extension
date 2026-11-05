import { describe, expect, it } from 'vitest';
import { isManualEntrySaveInput } from '../../background/vault/commands';
import { workspaceCommandSchema } from '../workspace/commands';
const method = { id: 'custom:AAAAAA11-1111-4111-8111-111111111111', provider: 'google', account: 'synthetic@test', entry: null, agentVisible: false };
const credential = { entryType: 'credential', label: 'OAuth only', username: '', password: '', signInMethods: [method] };
describe('independent popup-worker sign-in input boundary', () => {
 it('accepts OAuth-only Credentials while rejecting passwordless methods-free input and other Entry types', () => {
  expect(isManualEntrySaveInput(credential)).toBe(true);
  expect(isManualEntrySaveInput({ ...credential, signInMethods: [] })).toBe(false);
  expect(isManualEntrySaveInput({ entryType: 'key', label: 'Key', value: 'synthetic', signInMethods: [method] })).toBe(false);
 });
 it.each([
  [{ ...method, id: 'custom:invalid' }],
  [{ ...method, provider: 'unknown' }],
  [{ ...method, entry: { vaultId: '11111111-1111-4111-8111-111111111111', entryId: '22222222-2222-4222-8222-222222222222' } }],
  [{ ...method, token: 'synthetic' }],
  [method, method],
 ].map(methods => [methods]))('rejects malformed, duplicate and unapproved references', signInMethods => {
  expect(isManualEntrySaveInput({ ...credential, signInMethods })).toBe(false);
 });
 it('requires exact stable ID or explicit add and bounded visibility on mutation commands', () => {
  const command = { type: 'workspace/sign-in', vaultId: '11111111-1111-4111-8111-111111111111', entryId: '22222222-2222-4222-8222-222222222222', fieldId: method.id, binding: { provider: 'google', account: null }, agentVisible: false, locale: 'en' };
  expect(workspaceCommandSchema.safeParse(command).success).toBe(true);
  expect(workspaceCommandSchema.safeParse({ ...command, fieldId: 'provider:google' }).success).toBe(false);
  expect(workspaceCommandSchema.safeParse({ ...command, agentVisible: undefined }).success).toBe(false);
  expect(workspaceCommandSchema.safeParse({ ...command, binding: { ...command.binding, entry: {} } }).success).toBe(false);
 });
});
