import { expect, it } from 'vitest';
import wire from '../../../tests/fixtures/protocol/deferred-control-click-v2.json';
import { parseAgentInjectionRequest, parseAgentInjectForm, isAgentInjectStepMessage, AGENT_INJECT_STEP_CHANNEL } from './agent-inject';
import { isDeferredFillMessage, parseDeferredSubmit, parseDeferredCancel, parseSubmitReady } from './agent-deferred';

it('preserves the shared explicit custom-control action on the deferred channel only', () => {
  expect(parseAgentInjectionRequest(wire.inject)?.form.steps[0]?.submit.action).toBe('deferred-control-click');
  expect(parseDeferredSubmit(wire.submit)).not.toBeNull();
  expect(parseDeferredCancel(wire.cancel)).not.toBeNull();
  expect(parseSubmitReady(wire.submitReady.submitReady)).not.toBeNull();
  expect(isDeferredFillMessage({ channel: 'palladin.agent-live/deferred-fill', pendingId: 'b'.repeat(32), documentId: 'd'.repeat(32),
    expectedDomain: wire.inject.expectedDomain, form: wire.inject.form, values: wire.inject.values, expiresAt: wire.inject.expiresAt })).toBe(true);
  expect(isAgentInjectStepMessage({ channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain: wire.inject.expectedDomain,
    documentId: 'd'.repeat(32), step: wire.inject.form.steps[0], values: wire.inject.values })).toBe(false);
});
it.each(['v1', 'reversed', 'totp', 'registration', 'duplicate-field', 'duplicate-selector', 'scope-selector', 'other-snapshot', 'css', 'extra-step'])(
  'rejects malformed custom deferred contract: %s', mutation => {
    const form = structuredClone(wire.inject.form), fields = form.steps[0]!.fields;
    if (mutation === 'v1') form.version = 1;
    if (mutation === 'reversed') fields.reverse();
    if (mutation === 'totp') { fields[1]!.entryFieldId = 'credential.totp'; fields[1]!.control = 'otp'; }
    if (mutation === 'registration') { fields[1]!.entryFieldId = 'profile.email'; fields[1]!.control = 'text'; }
    if (mutation === 'duplicate-field') fields[1]!.entryFieldId = 'credential.username';
    if (mutation === 'duplicate-selector') fields[1]!.selector = fields[0]!.selector;
    if (mutation === 'scope-selector') fields[1]!.selector = form.steps[0]!.submit.selector;
    if (mutation === 'other-snapshot') fields[1]!.selector = fields[1]!.selector.replace('a'.repeat(32), 'f'.repeat(32));
    if (mutation === 'css') form.steps[0]!.submit.selector = 'a.button';
    if (mutation === 'extra-step') form.steps.push(structuredClone(form.steps[0]!));
    expect(parseAgentInjectForm(form)).toBeNull();
  });
