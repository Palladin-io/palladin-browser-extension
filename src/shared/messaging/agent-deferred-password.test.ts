import { expect, it } from 'vitest';
import wire from '../../../tests/fixtures/protocol/deferred-password-v2.json';
import { parseAgentInjectionRequest, parseAgentInjectForm, isAgentInjectStepMessage, AGENT_INJECT_STEP_CHANNEL } from './agent-inject';
import { isDeferredFillMessage, parseDeferredSubmit, parseDeferredCancel, parseSubmitReady } from './agent-deferred';
it.each(Object.entries(wire))('accepts the frozen %s password contract on the deferred channel only', (_name, example) => {
  expect(parseAgentInjectionRequest(example.inject)).not.toBeNull();
  expect(parseDeferredSubmit(example.submit)).not.toBeNull(); expect(parseDeferredCancel(example.cancel)).not.toBeNull();
  expect(parseSubmitReady(example.submitReady.submitReady)).not.toBeNull();
  expect(isAgentInjectStepMessage({ channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain: example.inject.expectedDomain, documentId: 'd'.repeat(32),
    step: example.inject.form.steps[0], values: example.inject.values })).toBe(false);
});
it('accepts only the explicit worker-owned carried-identity requirement on private fill', () => {
  const inject = wire.carriedUsername.inject;
  const message = { channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: 'd'.repeat(32), expectedDomain: inject.expectedDomain,
    form: inject.form, values: inject.values, expiresAt: inject.expiresAt, requireExistingUsername: true };
  expect(isDeferredFillMessage(message)).toBe(true);
  expect(isDeferredFillMessage({ ...message, requireExistingUsername: false })).toBe(false);
  expect(isDeferredFillMessage({ ...message, requireExistingUsername: 'true' })).toBe(false);
});
it.each(['reversed', 'totp', 'control', 'duplicate-field', 'duplicate-selector', 'scope-selector', 'other-snapshot', 'extra-field'])('rejects malformed deferred password fields: %s', mutation => {
  const form = structuredClone(wire.carriedUsername.inject.form), fields = form.steps[0]!.fields;
  if (mutation === 'reversed') fields.reverse();
  if (mutation === 'totp') { fields[1]!.entryFieldId = 'credential.totp'; fields[1]!.control = 'otp'; }
  if (mutation === 'control') fields[1]!.control = 'username';
  if (mutation === 'duplicate-field') fields[1]!.entryFieldId = 'credential.username';
  if (mutation === 'duplicate-selector') fields[1]!.selector = fields[0]!.selector;
  if (mutation === 'scope-selector') fields[1]!.selector = form.steps[0]!.submit.selector;
  if (mutation === 'other-snapshot') fields[1]!.selector = fields[1]!.selector.replace('a'.repeat(32), 'f'.repeat(32));
  if (mutation === 'extra-field') fields.push({ ...fields[0]!, entryFieldId: 'credential.other' });
  expect(parseAgentInjectForm(form)).toBeNull();
});
