import {
  AGENT_INJECT_PROTOCOL,
  parseAgentInjectionRequest,
  parseAgentPrepareRequest,
  valuesForAgentInjectStep,
  type AgentInjectFailure,
  type AgentInjectFieldValue,
  type AgentInjectFormStep,
  type AgentInjectStepOutcome,
  type AgentInjectTransitionOutcome,
  type AgentInjectWaitFor,
} from "@shared/messaging";
import { isSecurePage, matchesAgentInjectionTarget } from "@shared/security/domain";

export const NATIVE_HOST_NAME = "io.palladin.browser_bridge";

const TRANSITION_POLL_MS = 100;
const DEFAULT_TRANSITION_TIMEOUT_MS = 20_000;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/;

export interface AgentPage {
  readonly url: string;
  readonly documentId: string;
}

export interface AgentTabState {
  readonly id: number;
  /** Null only while the top-frame isolated world is unavailable during navigation. */
  readonly page: AgentPage | null;
}

export interface AgentFillDeps {
  getActivePage(): Promise<AgentTabState | null>;
  sendStep(
    tabId: number,
    expectedDomain: string,
    step: AgentInjectFormStep,
    values: readonly AgentInjectFieldValue[],
  ): Promise<AgentInjectStepOutcome | null>;
  probeTransition(
    tabId: number,
    expectedDomain: string,
    selector: string,
  ): Promise<AgentInjectTransitionOutcome | null>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface PreparedAgentPage {
  readonly tabId: number;
  readonly documentId: string;
}

export interface AgentProviderSession {
  prepared: PreparedAgentPage | null;
}

export interface TransactionReplayGuard {
  consume(transactionId: string): Promise<boolean>;
}

export type AgentInjectionOutcome =
  | "injected"
  | "rejected"
  | AgentInjectFailure;

export interface AgentInjectionResult {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "inject.result";
  readonly transactionId: string | null;
  readonly outcome: AgentInjectionOutcome;
}

export interface AgentPrepareResult {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "prepare.result";
  readonly nonce: string | null;
  readonly currentUrl: string | null;
  readonly outcome: "ready" | "provider-unavailable" | "invalid-request";
}

/**
 * One Native Messaging connection owns one prepare/inject session. The native host serializes
 * clients, verifies provider+nonce, and strips those fields before forwarding the Inject frame.
 */
export async function handleNativeAgentMessage(
  deps: AgentFillDeps,
  replay: TransactionReplayGuard,
  session: AgentProviderSession,
  raw: unknown,
): Promise<AgentInjectionResult | AgentPrepareResult> {
  const prepare = parseAgentPrepareRequest(raw);
  if (prepare !== null) {
    const tab = await deps.getActivePage();
    if (tab?.page === null || tab === null) {
      session.prepared = null;
      return prepareResult(prepare.nonce, null, "provider-unavailable");
    }
    session.prepared = { tabId: tab.id, documentId: tab.page.documentId };
    return prepareResult(prepare.nonce, tab.page.url, "ready");
  }

  const prepared = session.prepared;
  session.prepared = null;
  const request = parseAgentInjectionRequest(raw);
  if (request === null) {
    wipeAgentMessageValues(raw);
    return result(safeTransactionId(raw), "rejected");
  }
  if (prepared === null) {
    wipeValues(request.values);
    return result(request.transactionId, "provider-unavailable");
  }
  return handleAgentInjection(deps, replay, prepared, request);
}

/** Pure orchestration after the native host has authenticated and correlated the provider frame. */
export async function handleAgentInjection(
  deps: AgentFillDeps,
  replay: TransactionReplayGuard,
  prepared: PreparedAgentPage,
  request: NonNullable<ReturnType<typeof parseAgentInjectionRequest>>,
): Promise<AgentInjectionResult> {
  try {
    if (!(await replay.consume(request.transactionId))) {
      return result(request.transactionId, "rejected");
    }
    let current = await deps.getActivePage();
    if (current?.page === null || current === null || current.id !== prepared.tabId) {
      return result(request.transactionId, "provider-unavailable");
    }
    // A document replacement between public preparation and secret delivery invalidates the plan.
    if (current.page.documentId !== prepared.documentId) {
      return result(request.transactionId, "rejected");
    }

    for (const step of request.form.steps) {
      current = await deps.getActivePage();
      if (current?.page === null || current === null || current.id !== prepared.tabId) {
        return result(request.transactionId, "provider-unavailable");
      }
      const origin = originFailure(current.page.url, request.expectedDomain);
      if (origin !== null) return result(request.transactionId, origin);

      const stepValues = valuesForAgentInjectStep(request.values, step);
      let outcome: AgentInjectStepOutcome | null;
      try {
        outcome = await deps.sendStep(prepared.tabId, request.expectedDomain, step, stepValues);
      } finally {
        wipeValues(stepValues);
      }
      if (outcome === null) return result(request.transactionId, "provider-unavailable");
      if (!outcome.ok) {
        return result(request.transactionId, normalizeFormFailure(outcome.outcome));
      }

      if (step.waitFor !== undefined) {
        const transition = await waitForTransition(
          deps,
          prepared.tabId,
          request.expectedDomain,
          step.waitFor,
        );
        if (transition !== null) return result(request.transactionId, transition);
      }
    }
    return result(request.transactionId, "injected");
  } finally {
    wipeValues(request.values);
  }
}

async function waitForTransition(
  deps: AgentFillDeps,
  tabId: number,
  expectedDomain: string,
  transition: AgentInjectWaitFor,
): Promise<AgentInjectFailure | null> {
  const wait = deps.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeout = transition.timeoutMs ?? DEFAULT_TRANSITION_TIMEOUT_MS;
  const attempts = Math.max(1, Math.ceil(timeout / TRANSITION_POLL_MS));
  let sawStructuralMiss = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(TRANSITION_POLL_MS);
    const current = await deps.getActivePage();
    if (current === null || current.id !== tabId) return "provider-unavailable";
    if (current.page === null) continue;
    const origin = originFailure(current.page.url, expectedDomain);
    if (origin !== null) return origin;
    const outcome = await deps.probeTransition(tabId, expectedDomain, transition.selector);
    if (outcome === null) continue;
    if (outcome.status === "missing") {
      sawStructuralMiss = true;
      continue;
    }
    if (outcome.status === "ready") return null;
    if (outcome.status === "ambiguous") return "stale-form-map";
    return outcome.status;
  }
  return sawStructuralMiss ? "stale-form-map" : "provider-unavailable";
}

function normalizeFormFailure(outcome: AgentInjectFailure): AgentInjectFailure {
  return outcome === "no-password-field"
    || outcome === "no-submit-control"
    || outcome === "ambiguous-form"
    ? "stale-form-map"
    : outcome;
}

function originFailure(url: string, expectedDomain: string): AgentInjectFailure | null {
  if (!isSecurePage(url)) return "insecure-origin";
  return matchesAgentInjectionTarget(url, expectedDomain) ? null : "origin-mismatch";
}

function result(
  transactionId: string | null,
  outcome: AgentInjectionOutcome,
): AgentInjectionResult {
  return {
    protocol: AGENT_INJECT_PROTOCOL,
    type: "inject.result",
    transactionId,
    outcome,
  };
}

function prepareResult(
  nonce: string | null,
  currentUrl: string | null,
  outcome: AgentPrepareResult["outcome"],
): AgentPrepareResult {
  return {
    protocol: AGENT_INJECT_PROTOCOL,
    type: "prepare.result",
    nonce,
    currentUrl,
    outcome,
  };
}

function safeTransactionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const transactionId = (value as Record<string, unknown>).transactionId;
  return typeof transactionId === "string" && IDENTIFIER.test(transactionId)
    ? transactionId
    : null;
}

function wipeValues(values: readonly AgentInjectFieldValue[]): void {
  for (const field of values) (field as { value: string }).value = "";
}

export function wipeAgentMessageValues(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const values = (value as Record<string, unknown>).values;
  if (!Array.isArray(values)) return;
  for (const field of values) {
    if (typeof field !== "object" || field === null || Array.isArray(field)) continue;
    const record = field as Record<string, unknown>;
    if (typeof record.value === "string") record.value = "";
  }
}
