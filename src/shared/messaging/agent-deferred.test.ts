import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/protocol/deferred-live-v2.json';
import { parseAgentInjectionRequest, parseAgentInjectForm, isAgentInjectStepMessage, AGENT_INJECT_STEP_CHANNEL } from './agent-inject';
import { parseDeferredSubmit, parseDeferredCancel, parseSubmitReady, isDeferredFillMessage, DEFERRED_FILL } from './agent-deferred';
describe('explicit deferred username-only wire', () => {
  it('accepts the frozen additive contract and rejects it on the ordinary DOM-step channel', () => {
    expect(parseAgentInjectionRequest(fixture.inject)).not.toBeNull(); expect(parseDeferredSubmit(fixture.submit)).not.toBeNull();
    expect(parseDeferredCancel(fixture.cancel)).not.toBeNull(); expect(parseSubmitReady(fixture.submitReady.submitReady)).not.toBeNull();
    expect(isAgentInjectStepMessage({ channel: AGENT_INJECT_STEP_CHANNEL, expectedDomain: fixture.inject.expectedDomain, documentId: 'd'.repeat(32),
      step: fixture.inject.form.steps[0], values: fixture.inject.values })).toBe(false);
  });
  it.each(['password','totp','mixed','v1','wait','different-snapshot','same-selector','missing-expiry'])('rejects deferred %s', mutation => {
    const raw = structuredClone(fixture.inject);
    const field = raw.form.steps[0]!.fields[0]!;
    if (mutation === 'password' || mutation === 'totp') { field.entryFieldId = `credential.${mutation}`; field.control = mutation === 'totp' ? 'otp' : mutation; }
    if (mutation === 'mixed') raw.form.steps[0]!.fields.push({ ...field, entryFieldId: 'credential.password', control: 'password' });
    if (mutation === 'v1') raw.form.version = 1;
    if (mutation === 'wait') Object.assign(raw.form.steps[0]!, { waitFor: { selector: '#anything' } });
    if (mutation === 'different-snapshot') field.selector = field.selector.replace('a'.repeat(32), 'e'.repeat(32));
    if (mutation === 'same-selector') raw.form.steps[0]!.submit.selector = field.selector;
    if (mutation === 'missing-expiry') Reflect.deleteProperty(raw, 'expiresAt');
    expect(parseAgentInjectionRequest(raw)).toBeNull();
  });
  it('retains v1 map parsing and rejects value-bearing commit/cancel', () => {
    expect(parseAgentInjectForm({ version: 1, steps: [{ fields: [{ entryFieldId: 'credential.username', control: 'username', selector: '#login' }], submit: { action: 'click', selector: '#submit' } }] })).not.toBeNull();
    expect(parseDeferredSubmit({ ...fixture.submit, values: fixture.inject.values })).toBeNull();
    expect(parseDeferredCancel({ ...fixture.cancel, values: fixture.inject.values })).toBeNull();
  });
});

it('keeps automatic replacement metadata on the private worker channel only', () => {
  const base = { channel: DEFERRED_FILL, pendingId: 'b'.repeat(32), documentId: 'd'.repeat(32), expectedDomain: fixture.inject.expectedDomain,
    form: fixture.inject.form, values: fixture.inject.values, expiresAt: fixture.inject.expiresAt };
  expect(isDeferredFillMessage(base)).toBe(true);
  expect(isDeferredFillMessage({ ...base, automaticFillSessionId: 'a'.repeat(32) })).toBe(true);
  for (const marker of [true, '', 'invalid']) expect(isDeferredFillMessage({ ...base, automaticFillSessionId: marker })).toBe(false);
  expect(isDeferredFillMessage({ ...base, automaticFillSessionId: 'a'.repeat(32), requireExistingUsername: true })).toBe(false);
  expect(parseAgentInjectionRequest({ ...fixture.inject, automaticFillSessionId: 'a'.repeat(32) })).toBeNull();
  expect(parseAgentInjectionRequest({ ...fixture.inject, allowAutomaticReplacement: true })).toBeNull();
});
