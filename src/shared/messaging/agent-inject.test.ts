import { describe, expect, it } from "vitest";

import {
  AGENT_INJECT_STEP_CHANNEL,
  AGENT_INJECT_TRANSITION_CHANNEL,
  isAgentInjectStepMessage,
  isAgentInjectStepOutcome,
  isAgentInjectTransitionMessage,
  isAgentInjectTransitionOutcome,
  parseAgentInjectForm,
  parseAgentInjectionRequest,
  parseAgentPrepareRequest,
} from "./agent-inject";

function form(): Record<string, unknown> {
  return {
    version: 1,
    steps: [
      {
        fields: [{ entryFieldId: "credential.username", selector: "#user", control: "username" }],
        submit: { action: "click", selector: "#next" },
        waitFor: { selector: "#password", timeoutMs: 20_000 },
      },
      {
        fields: [
          { entryFieldId: "credential.password", selector: "#password", control: "password" },
          { entryFieldId: "credential.totp", selector: "#otp", control: "otp" },
        ],
        submit: { action: "press-enter", selector: "#otp" },
      },
    ],
  };
}

function injection(): Record<string, unknown> {
  return {
    protocol: "palladin.inject-provider.v1",
    type: "inject",
    transactionId: "tx-1",
    grantId: "grant-1",
    entryId: "entry-1",
    expectedDomain: "login.example.com",
    form: form(),
    values: [
      { entryFieldId: "credential.username", value: "fixture-user" },
      { entryFieldId: "credential.password", value: "fixture-password" },
      { entryFieldId: "credential.totp", value: "123456" },
    ],
  };
}

describe("Agent Inject contract", () => {
  it("accepts the current Rust/Node prepare, form, and values shapes", () => {
    expect(parseAgentPrepareRequest({
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "a".repeat(64),
    })).not.toBeNull();
    const parsed = parseAgentInjectionRequest(injection());
    expect(parsed?.form.steps).toHaveLength(2);
    expect(parsed?.values.map((value) => value.entryFieldId)).toEqual([
      "credential.username",
      "credential.password",
      "credential.totp",
    ]);
  });

  it("rejects unknown fields, incomplete values, duplicate fields, and invalid transitions", () => {
    expect(parseAgentInjectionRequest({ ...injection(), extra: true })).toBeNull();
    expect(parseAgentInjectionRequest({
      ...injection(),
      values: [{ entryFieldId: "credential.username", value: "fixture-user" }],
    })).toBeNull();
    const emptyValue = injection();
    emptyValue.values = [
      { entryFieldId: "credential.username", value: "" },
      { entryFieldId: "credential.password", value: "fixture-password" },
      { entryFieldId: "credential.totp", value: "123456" },
    ];
    expect(parseAgentInjectionRequest(emptyValue)).toBeNull();
    const duplicate = form();
    const steps = duplicate.steps as Array<Record<string, unknown>>;
    const first = steps[0];
    if (first === undefined) throw new Error("fixture missing");
    first.fields = [
      { entryFieldId: "credential.username", selector: "#one", control: "username" },
      { entryFieldId: "credential.username", selector: "#two", control: "username" },
    ];
    expect(parseAgentInjectForm(duplicate)).toBeNull();

    const noTransition = form();
    const noTransitionSteps = noTransition.steps as Array<Record<string, unknown>>;
    const firstWithoutWait = noTransitionSteps[0];
    if (firstWithoutWait === undefined) throw new Error("fixture missing");
    delete firstWithoutWait.waitFor;
    expect(parseAgentInjectForm(noTransition)).toBeNull();
  });

  it("rejects public/private suffixes and a sibling-host widening target", () => {
    expect(parseAgentInjectionRequest({ ...injection(), expectedDomain: "github.io" })).toBeNull();
    expect(parseAgentInjectionRequest({ ...injection(), expectedDomain: "Login.Example.com" })).toBeNull();
    expect(parseAgentInjectionRequest({ ...injection(), expectedDomain: "example.com/path" })).toBeNull();
  });

  it("validates the isolated-world step and transition message vocabularies exactly", () => {
    const parsed = parseAgentInjectionRequest(injection());
    if (parsed === null) throw new Error("fixture invalid");
    const step = parsed.form.steps[1];
    if (step === undefined) throw new Error("fixture missing");
    const values = parsed.values.filter((value) =>
      step.fields.some((field) => field.entryFieldId === value.entryFieldId));
    expect(isAgentInjectStepMessage({
      channel: AGENT_INJECT_STEP_CHANNEL,
      expectedDomain: parsed.expectedDomain,
      step,
      values,
    })).toBe(true);
    expect(isAgentInjectStepMessage({
      channel: AGENT_INJECT_STEP_CHANNEL,
      expectedDomain: parsed.expectedDomain,
      step,
      values,
      extra: true,
    })).toBe(false);
    expect(isAgentInjectTransitionMessage({
      channel: AGENT_INJECT_TRANSITION_CHANNEL,
      expectedDomain: parsed.expectedDomain,
      selector: "#password",
    })).toBe(true);
    expect(isAgentInjectStepOutcome({ ok: true })).toBe(true);
    expect(isAgentInjectStepOutcome({ ok: false, outcome: "stale-form-map" })).toBe(true);
    expect(isAgentInjectStepOutcome({ ok: false, outcome: "replayed" })).toBe(false);
    expect(isAgentInjectTransitionOutcome({ status: "ambiguous" })).toBe(true);
    expect(isAgentInjectTransitionOutcome({ status: "unknown" })).toBe(false);
  });
});
