/** Strict, provider-neutral Agent Inject wire and isolated-world contracts. */

import { registrableDomain } from "@shared/security/domain";

export const AGENT_INJECT_PROTOCOL = "palladin.inject-provider.v1" as const;
export const AGENT_INJECT_STEP_CHANNEL = "palladin.agent-inject/step" as const;
export const AGENT_INJECT_TRANSITION_CHANNEL = "palladin.agent-inject/transition" as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FIELD_ID_LENGTH = 128;
const MAX_FIELD_LENGTH = 64 * 1024;
const MAX_SELECTOR_LENGTH = 1_024;
const MAX_FORM_STEPS = 8;
const MAX_FORM_FIELDS = 16;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const FIELD_ID = /^[A-Za-z0-9._:-]+$/;
const CONTROLS = new Set<AgentInjectControl>([
  "username",
  "password",
  "text",
  "email",
  "tel",
  "otp",
]);

export type AgentInjectControl = "username" | "password" | "text" | "email" | "tel" | "otp";

export interface AgentInjectFormField {
  readonly entryFieldId: string;
  readonly selector: string;
  readonly control: AgentInjectControl;
}

export interface AgentInjectSubmit {
  readonly action: "click" | "press-enter";
  readonly selector: string;
}

export interface AgentInjectWaitFor {
  readonly selector: string;
  readonly timeoutMs?: number;
}

export interface AgentInjectFormStep {
  readonly fields: readonly AgentInjectFormField[];
  readonly submit: AgentInjectSubmit;
  readonly waitFor?: AgentInjectWaitFor;
}

export interface AgentInjectForm {
  readonly version: 1;
  readonly steps: readonly AgentInjectFormStep[];
}

export interface AgentInjectFieldValue {
  readonly entryFieldId: string;
  readonly value: string;
}

export interface AgentPrepareRequest {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "prepare";
  readonly nonce: string;
}

export interface AgentInjectionRequest {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "inject";
  readonly transactionId: string;
  readonly grantId: string;
  readonly entryId: string;
  readonly expectedDomain: string;
  readonly form: AgentInjectForm;
  readonly values: readonly AgentInjectFieldValue[];
}

export interface AgentInjectStepMessage {
  readonly channel: typeof AGENT_INJECT_STEP_CHANNEL;
  readonly expectedDomain: string;
  readonly step: AgentInjectFormStep;
  readonly values: readonly AgentInjectFieldValue[];
}

export interface AgentInjectTransitionMessage {
  readonly channel: typeof AGENT_INJECT_TRANSITION_CHANNEL;
  readonly expectedDomain: string;
  readonly selector: string;
}

export type AgentInjectFailure =
  | "no-password-field"
  | "no-submit-control"
  | "origin-mismatch"
  | "insecure-origin"
  | "ambiguous-form"
  | "provider-unavailable";

export type AgentInjectStepOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: AgentInjectFailure };

export type AgentInjectTransitionOutcome =
  | { readonly status: "ready" }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous" }
  | { readonly status: "origin-mismatch" }
  | { readonly status: "insecure-origin" };

export function parseAgentPrepareRequest(value: unknown): AgentPrepareRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ["protocol", "type", "nonce"])) return null;
  if (value.protocol !== AGENT_INJECT_PROTOCOL
    || value.type !== "prepare"
    || typeof value.nonce !== "string"
    || !/^[A-Za-z0-9]{32,128}$/.test(value.nonce)) return null;
  return value as unknown as AgentPrepareRequest;
}

export function parseAgentInjectionRequest(value: unknown): AgentInjectionRequest | null {
  if (!isRecord(value) || !onlyKeys(value, [
    "protocol",
    "type",
    "transactionId",
    "grantId",
    "entryId",
    "expectedDomain",
    "form",
    "values",
  ])) return null;
  if (value.protocol !== AGENT_INJECT_PROTOCOL
    || value.type !== "inject"
    || !validIdentifier(value.transactionId)
    || !validIdentifier(value.grantId)
    || !validIdentifier(value.entryId)
    || !validExpectedDomain(value.expectedDomain)) return null;
  const form = parseAgentInjectForm(value.form);
  if (form === null) return null;
  const values = parseAgentInjectValues(value.values, form);
  if (values === null) return null;
  return { ...(value as unknown as Omit<AgentInjectionRequest, "form" | "values">), form, values };
}

export function parseAgentInjectForm(value: unknown): AgentInjectForm | null {
  if (!isRecord(value) || !onlyKeys(value, ["version", "steps"])
    || value.version !== 1 || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > MAX_FORM_STEPS) return null;
  let totalFields = 0;
  const steps: AgentInjectFormStep[] = [];
  for (let index = 0; index < value.steps.length; index += 1) {
    const step = parseStep(value.steps[index]);
    if (step === null) return null;
    totalFields += step.fields.length;
    if (totalFields > MAX_FORM_FIELDS) return null;
    if (index < value.steps.length - 1 && step.waitFor === undefined) return null;
    steps.push(step);
  }
  return { version: 1, steps };
}

export function parseAgentInjectValues(
  value: unknown,
  form: AgentInjectForm,
): AgentInjectFieldValue[] | null {
  if (!Array.isArray(value)) return null;
  const required = new Set(
    form.steps.flatMap((step) => step.fields.map((field) => field.entryFieldId)),
  );
  const seen = new Set<string>();
  const values: AgentInjectFieldValue[] = [];
  for (const item of value) {
    if (!isRecord(item) || !onlyKeys(item, ["entryFieldId", "value"])
      || typeof item.entryFieldId !== "string" || !required.has(item.entryFieldId)
      || seen.has(item.entryFieldId) || typeof item.value !== "string"
      || item.value.length > MAX_FIELD_LENGTH) return null;
    seen.add(item.entryFieldId);
    values.push(item as unknown as AgentInjectFieldValue);
  }
  return seen.size === required.size ? values : null;
}

export function isAgentInjectStepMessage(value: unknown): value is AgentInjectStepMessage {
  if (!isRecord(value) || !onlyKeys(value, ["channel", "expectedDomain", "step", "values"])
    || value.channel !== AGENT_INJECT_STEP_CHANNEL
    || !validExpectedDomain(value.expectedDomain)) return false;
  const step = parseStep(value.step);
  if (step === null) return false;
  return parseAgentInjectValues(value.values, { version: 1, steps: [step] }) !== null;
}

export function isAgentInjectTransitionMessage(
  value: unknown,
): value is AgentInjectTransitionMessage {
  return isRecord(value)
    && onlyKeys(value, ["channel", "expectedDomain", "selector"])
    && value.channel === AGENT_INJECT_TRANSITION_CHANNEL
    && validExpectedDomain(value.expectedDomain)
    && validSelector(value.selector);
}

export function isAgentInjectStepOutcome(value: unknown): value is AgentInjectStepOutcome {
  if (!isRecord(value) || !onlyKeys(value, value.ok === true ? ["ok"] : ["ok", "outcome"])) {
    return false;
  }
  return value.ok === true || (value.ok === false && isAgentInjectFailure(value.outcome));
}

export function isAgentInjectTransitionOutcome(
  value: unknown,
): value is AgentInjectTransitionOutcome {
  return isRecord(value)
    && onlyKeys(value, ["status"])
    && (value.status === "ready"
      || value.status === "missing"
      || value.status === "ambiguous"
      || value.status === "origin-mismatch"
      || value.status === "insecure-origin");
}

export function valuesForAgentInjectStep(
  values: readonly AgentInjectFieldValue[],
  step: AgentInjectFormStep,
): AgentInjectFieldValue[] {
  const byId = new Map(values.map((value) => [value.entryFieldId, value.value]));
  return step.fields.map((field) => ({
    entryFieldId: field.entryFieldId,
    value: byId.get(field.entryFieldId) ?? "",
  }));
}

function parseStep(value: unknown): AgentInjectFormStep | null {
  if (!isRecord(value) || !onlyKeys(value, ["fields", "submit", "waitFor"])
    || !Array.isArray(value.fields) || value.fields.length < 1) return null;
  const fields: AgentInjectFormField[] = [];
  const stepIds = new Set<string>();
  for (const rawField of value.fields) {
    if (!isRecord(rawField) || !onlyKeys(rawField, ["entryFieldId", "selector", "control"])
      || !validFieldId(rawField.entryFieldId) || !validSelector(rawField.selector)
      || typeof rawField.control !== "string"
      || !CONTROLS.has(rawField.control as AgentInjectControl)
      || stepIds.has(rawField.entryFieldId)) return null;
    stepIds.add(rawField.entryFieldId);
    fields.push(rawField as unknown as AgentInjectFormField);
  }
  const submit = value.submit;
  if (!isRecord(submit) || !onlyKeys(submit, ["action", "selector"])
    || (submit.action !== "click" && submit.action !== "press-enter")
    || !validSelector(submit.selector)
    || (submit.action === "press-enter"
      && !fields.some((field) => field.selector === submit.selector))) return null;
  let waitFor: AgentInjectWaitFor | undefined;
  if (value.waitFor !== undefined) {
    if (!isRecord(value.waitFor) || !onlyKeys(value.waitFor, ["selector", "timeoutMs"])
      || !validSelector(value.waitFor.selector)
      || (value.waitFor.timeoutMs !== undefined
        && (typeof value.waitFor.timeoutMs !== "number"
          || !Number.isSafeInteger(value.waitFor.timeoutMs)
          || value.waitFor.timeoutMs < 100
          || value.waitFor.timeoutMs > 60_000))) return null;
    waitFor = value.waitFor as unknown as AgentInjectWaitFor;
  }
  return {
    fields,
    submit: submit as unknown as AgentInjectSubmit,
    ...(waitFor === undefined ? {} : { waitFor }),
  };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER.test(value);
}

function validFieldId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_FIELD_ID_LENGTH
    && FIELD_ID.test(value);
}

function validSelector(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_SELECTOR_LENGTH
    && value === value.trim()
    && !value.includes("\0");
}

function validExpectedDomain(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253
    || value !== value.trim() || value !== value.toLowerCase()
    || value.includes("/") || value.includes(":")
    || value.startsWith(".") || value.endsWith(".")) return false;
  if (!value.split(".").every((label) => label.length > 0
    && !label.startsWith("-") && !label.endsWith("-") && /^[a-z0-9-]+$/.test(label))) {
    return false;
  }
  // A public/private suffix alone is never a credential target.
  return registrableDomain(value) !== null;
}

function isAgentInjectFailure(value: unknown): value is AgentInjectFailure {
  return value === "no-password-field"
    || value === "no-submit-control"
    || value === "origin-mismatch"
    || value === "insecure-origin"
    || value === "ambiguous-form"
    || value === "provider-unavailable";
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
