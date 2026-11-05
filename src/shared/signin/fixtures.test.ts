import { createCapturedCredentialSecret, currentVaultPlaintext, signInMethodsDiscoverySchema } from '@palladin/crypto';
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/v2.json';
import { readSignInMethods } from './binding';

describe('versioned federated sign-in fixtures', () => {
 it.each(fixtures.positive)('reads all canonical methods and delegates redacted discovery to the SDK', fixture => {
  const secret = createCapturedCredentialSecret({ label: 'Synthetic', username: '', password: '', url: 'https://example.test', urlDomain: 'example.test' });
  const fields = fixture.methods.map(method => ({ id: method.id, label: 'Private label', type: 'palladin.signin.v2', value: { provider: method.provider, account: 'private@test', entry: method.entry } }));
  const input = { ...secret, content: { ...secret.content, customFields: fields }, agentFieldAccess: { ...secret.agentFieldAccess, ...Object.fromEntries(fields.map(field => [field.id, 'discovery' as const])) } };
  expect(readSignInMethods(input).map(method => method.id)).toEqual(fixture.methods.map(method => method.id));
  const projection = currentVaultPlaintext.projectAgentDiscovery(input)!;
  const value = projection.fields.find(field => field.id === 'signInMethods')!.value;
  expect(JSON.parse(value)).toEqual(fixture);
  expect(value).not.toContain('private@test');
  expect(value).not.toContain('Private label');
 });
 it.each(fixtures.negative.map(value => [value]))('rejects unsupported versions and invalid disclosure shapes', value => {
  expect(signInMethodsDiscoverySchema.safeParse(value).success).toBe(false);
 });
});
