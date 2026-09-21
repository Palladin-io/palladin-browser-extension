import { beginDeferredSubmit, commitDeferredSubmit, cancelPendingDeferred, type PendingDeferredSubmit } from './native-deferred';
import { parseDeferredSubmit, parseDeferredCancel, type DeferredFillMessage, type DeferredCommitMessage, type DeferredFillOutcome, type SubmitReady } from '@shared/messaging/agent-deferred';
import { sameLiveForm } from '@shared/messaging/agent-live';
import type { LiveLoginProbe, LiveContinuation } from '@shared/messaging/agent-live';
import { bindLiveChain, advanceLiveChain, type LiveChain } from './native-live';
import { nativeHostNameForChannel } from "@shared/config/build-channel";
import {
  AGENT_INJECT_PROTOCOL,
  parseAgentInjectionRequest,
  type AgentInjectForm,
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
export const NATIVE_HOST_NAME = nativeHostNameForChannel(__PALLADIN_CHANNEL__);

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
  currentAutomaticFillSession?(): string | null;
  fillDeferred?(tabId: number, message: DeferredFillMessage): Promise<DeferredFillOutcome | null>;
  commitDeferred?(tabId: number, message: DeferredCommitMessage): Promise<AgentInjectStepOutcome | null>;
  cancelDeferred?(tabId: number, pendingId: string): Promise<void>;
  probeLiveLogin?(tabId: number, documentId: string, targetUrl: string): Promise<LiveLoginProbe | null>;
  inspectLiveLogin?(tabId: number, documentId: string, targetUrl: string): Promise<AgentInjectForm | null>;
  getActivePage(): Promise<AgentTabState | null>;
  getPageById(tabId: number): Promise<AgentTabState | null>;
  sendStep(
    tabId: number,
    expectedDomain: string,
    documentId: string,
    step: AgentInjectFormStep,
    values: readonly AgentInjectFieldValue[],
    requireExistingUsername?: boolean,
  ): Promise<AgentInjectStepOutcome | null>;
  probeTransition(
    tabId: number,
    expectedDomain: string,
    selector: string,
  ): Promise<AgentInjectTransitionOutcome | null>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface PreparedAgentPage {
  readonly requireExistingUsername?: boolean;
  readonly liveOrigin?: string;
  readonly liveExpiresAt?: number;
  readonly liveForm?: AgentInjectForm;
  readonly tabId: number;
  readonly documentId: string;
}

export interface AgentProviderSession {
  pendingSubmit?: PendingDeferredSubmit | null;
  liveChain?: LiveChain | null;
  prepared: PreparedAgentPage | null;
}

export interface TransactionReplayGuard {
  consume(transactionId: string): Promise<boolean>;
}

export type AgentInjectionOutcome =
  | "submit-ready"
  | "injected"
  | "rejected"
  | AgentInjectFailure;

export interface AgentInjectionResult {
  readonly submitReady?: SubmitReady;
  readonly continuation?: LiveContinuation;
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "inject.result";
  readonly transactionId: string | null;
  readonly outcome: AgentInjectionOutcome;
}

export interface AgentPrepareResult {
  readonly liveForm?: AgentInjectForm;
  readonly protocol: typeof AGENT_INJECT_PROTOCOL;
  readonly type: "prepare.result";
  readonly nonce: string | null;
  readonly currentUrl: string | null;
  readonly outcome: "ready"
    | "provider-unavailable"
    | "target-tab-unavailable"
    | "target-url-mismatch"
    | "invalid-request";
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
  const commit = parseDeferredSubmit(raw);
  if (commit) return commitDeferredSubmit(deps, replay, session, commit);
  const cancel = parseDeferredCancel(raw);
  if (cancel) {
    if (session.pendingSubmit?.pendingId === cancel.pendingId && session.pendingSubmit.preparedTransactionId === cancel.preparedTransactionId) cancelPendingDeferred(deps, session);
    return result(cancel.transactionId, 'rejected');
  }
  cancelPendingDeferred(deps, session);
  const prepare = parseAgentPrepareRequest(raw);
  if (prepare !== null) {
    session.liveChain = null;
    const tab = prepare.targetTabId === undefined
      ? await deps.getActivePage()
      : await deps.getPageById(prepare.targetTabId);
    if (tab?.page === null || tab === null) {
      session.prepared = null;
      return prepareResult(
        prepare.nonce,
        null,
        prepare.targetTabId === undefined ? "provider-unavailable" : "target-tab-unavailable",
      );
    }
    if (prepare.targetUrl !== undefined && tab.page.url !== prepare.targetUrl) {
      session.prepared = null;
      return prepareResult(prepare.nonce, null, "target-url-mismatch");
    }
    if (prepare.liveDetection === true) {
      const form = await deps.inspectLiveLogin?.(tab.id, tab.page.documentId, tab.page.url);
      const after = await deps.getPageById(tab.id);
      if (!form || !after?.page || after.id !== tab.id || after.page.documentId !== tab.page.documentId || after.page.url !== tab.page.url) {
        session.prepared = null;
        return prepareResult(prepare.nonce, null, 'provider-unavailable');
      }
      session.prepared = { tabId: tab.id, documentId: tab.page.documentId, liveForm: form, liveOrigin: new URL(tab.page.url).origin };
      return { ...prepareResult(prepare.nonce, tab.page.url, 'ready'), liveForm: form };
    }
    session.prepared = { tabId: tab.id, documentId: tab.page.documentId };
    return prepareResult(prepare.nonce, tab.page.url, "ready");
  }

  const prepared = session.prepared;
  const priorChain = session.liveChain;
  session.liveChain = null;
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
  const usesLiveRefs = request.form.steps.some(step => step.fields.some(field => field.selector.startsWith('palladin-live:')));
  if ((prepared.liveForm && !sameLiveForm(prepared.liveForm, request.form))
    || (usesLiveRefs && !prepared.liveForm)) {
    wipeValues(request.values);
    return result(request.transactionId, 'rejected');
  }
  if (request.form.version === 2) {
    const chain = request.continueLive === true ? bindLiveChain(prepared, priorChain, request) : null;
    if (!chain) { wipeValues(request.values); return result(request.transactionId, 'rejected'); }
    return beginDeferredSubmit(deps, replay, session, prepared, chain, request);
  }
  if (request.continueLive === true) {
    const chain = bindLiveChain(prepared, priorChain, request);
    if (!chain) { wipeValues(request.values); return result(request.transactionId, 'rejected'); }
    const injected = await handleAgentInjection(deps, replay, { ...prepared, liveExpiresAt: chain.expiresAt }, request);
    if (injected.outcome !== 'injected') return injected;
    return { ...injected, continuation: await advanceLiveChain(deps, session, chain, request) };
  }
  if (priorChain) { wipeValues(request.values); return result(request.transactionId, 'rejected'); }
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
    let current = await deps.getPageById(prepared.tabId);
    if (current?.page === null || current === null || current.id !== prepared.tabId) {
      return result(request.transactionId, "provider-unavailable");
    }
    // A document replacement between public preparation and secret delivery invalidates the plan.
    if (current.page.documentId !== prepared.documentId) {
      return result(request.transactionId, "rejected");
    }

    for (const step of request.form.steps) {
      current = await deps.getPageById(prepared.tabId);
      if (current?.page === null || current === null || current.id !== prepared.tabId) {
        return result(request.transactionId, "provider-unavailable");
      }
      const origin = originFailure(current.page.url, request.expectedDomain);
      if (origin !== null) return result(request.transactionId, origin);
      if ((prepared.liveOrigin && new URL(current.page.url).origin !== prepared.liveOrigin)
        || (prepared.liveExpiresAt !== undefined && Date.now() >= prepared.liveExpiresAt)) return result(request.transactionId, 'rejected');

      const stepValues = valuesForAgentInjectStep(request.values, step);
      let outcome: AgentInjectStepOutcome | null;
      try {
        outcome = await deps.sendStep(
          prepared.tabId,
          request.expectedDomain,
          current.page.documentId,
          step,
          stepValues,
          ...(prepared.requireExistingUsername ? [true] : []),
        );
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
    const current = await deps.getPageById(tabId);
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
