import { AGENT_INJECT_PROTOCOL, generateNonce, type AgentInjectionRequest } from '@shared/messaging';
import { DEFERRED_FILL, DEFERRED_COMMIT, sameSubmitReady, type DeferredSubmitRequest, type SubmitReady } from '@shared/messaging/agent-deferred';
import { advanceLiveChain, type LiveChain } from './native-live';
import type { AgentFillDeps, AgentProviderSession, PreparedAgentPage, TransactionReplayGuard, AgentInjectionResult, AgentInjectionOutcome } from './native-provider';
import { matchesAgentInjectionTarget } from '@shared/security/domain';
export interface PendingDeferredSubmit {
  readonly pendingId: string; readonly preparedTransactionId: string; readonly tabId: number; readonly documentId: string;
  readonly chain: LiveChain; readonly request: AgentInjectionRequest; readonly expiresAt: number; readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  ready: SubmitReady | null;
}
const result = (transactionId: string, outcome: AgentInjectionOutcome): AgentInjectionResult => ({ protocol: AGENT_INJECT_PROTOCOL, type: 'inject.result', transactionId, outcome });
export function cancelPendingDeferred(deps: AgentFillDeps, session: AgentProviderSession): void {
  const pending = session.pendingSubmit; session.pendingSubmit = null;
  if (pending) { clearTimeout(pending.timer); void deps.cancelDeferred?.(pending.tabId, pending.pendingId).catch(() => undefined); }
}
export async function beginDeferredSubmit(deps: AgentFillDeps, replay: TransactionReplayGuard, session: AgentProviderSession,
  prepared: PreparedAgentPage, chain: LiveChain, request: AgentInjectionRequest): Promise<AgentInjectionResult> {
  let pending: PendingDeferredSubmit | null = null;
  try {
    if (!deps.fillDeferred || !request.expiresAt || !(await replay.consume(request.transactionId))) return result(request.transactionId, 'rejected');
    const tab = await deps.getPageById(prepared.tabId);
    const remaining = Math.min(10_000, request.expiresAt - Date.now(), chain.expiresAt - Date.now());
    if (remaining <= 0 || !tab?.page || tab.id !== prepared.tabId || tab.page.documentId !== prepared.documentId
      || new URL(tab.page.url).origin !== chain.origin || !matchesAgentInjectionTarget(tab.page.url, request.expectedDomain)) return result(request.transactionId, 'rejected');
    pending = { pendingId: generateNonce(), preparedTransactionId: request.transactionId, tabId: prepared.tabId, documentId: prepared.documentId,
      chain, request, expiresAt: Date.now() + remaining, deadline: performance.now() + remaining, ready: null,
      timer: setTimeout(() => { if (session.pendingSubmit === pending) cancelPendingDeferred(deps, session); }, remaining) };
    session.pendingSubmit = pending;
    const marker = chain.steps === 0 && !prepared.requireExistingUsername ? deps.currentAutomaticFillSession?.() : null;
    const response = await deps.fillDeferred(prepared.tabId, { channel: DEFERRED_FILL, pendingId: pending.pendingId, documentId: prepared.documentId,
      expectedDomain: request.expectedDomain, form: request.form, values: request.values, expiresAt: pending.expiresAt,
      ...(marker ? { automaticFillSessionId: marker } : {}),
      ...(prepared.requireExistingUsername ? { requireExistingUsername: true } : {}) });
    const current = await deps.getPageById(prepared.tabId);
    if (session.pendingSubmit !== pending || !response?.ok || !current?.page || current.id !== prepared.tabId
      || current.page.documentId !== prepared.documentId || current.page.url !== tab.page.url || !alive(pending)
      || response.submitReady.pendingId !== pending.pendingId || response.submitReady.documentId !== prepared.documentId
      || response.submitReady.currentUrl !== tab.page.url) {
      cancelPendingDeferred(deps, session); return result(request.transactionId, 'stale-form-map');
    }
    pending.ready = response.submitReady;
    return { ...result(request.transactionId, 'submit-ready'), submitReady: response.submitReady };
  } catch { cancelPendingDeferred(deps, session); return result(request.transactionId, 'provider-unavailable'); }
  finally { for (const value of request.values) (value as { value: string }).value = ''; }
}
export async function commitDeferredSubmit(deps: AgentFillDeps, replay: TransactionReplayGuard, session: AgentProviderSession, request: DeferredSubmitRequest): Promise<AgentInjectionResult> {
  const pending = session.pendingSubmit; session.pendingSubmit = null;
  if (!pending) return result(request.transactionId, 'rejected');
  clearTimeout(pending.timer);
  try {
    const ready = pending.ready;
    if (!ready || !deps.commitDeferred || request.preparedTransactionId !== pending.preparedTransactionId
      || request.grantId !== pending.chain.grantId || request.entryId !== pending.chain.entryId || request.expectedDomain !== pending.chain.expectedDomain
      || !sameSubmitReady(request.submitReady, ready) || !alive(pending) || Date.now() >= request.expiresAt
      || !(await replay.consume(request.transactionId))) return result(request.transactionId, 'rejected');
    const tab = await deps.getPageById(pending.tabId);
    if (!tab?.page || tab.id !== pending.tabId || tab.page.documentId !== pending.documentId || tab.page.url !== ready.currentUrl
      || !alive(pending) || Date.now() >= request.expiresAt) return result(request.transactionId, 'rejected');
    const response = await deps.commitDeferred(pending.tabId, { channel: DEFERRED_COMMIT, expectedDomain: request.expectedDomain,
      submitReady: ready, expiresAt: Math.min(request.expiresAt, pending.expiresAt) });
    if (!response?.ok) return result(request.transactionId, response ? response.outcome : 'provider-unavailable');
    return { ...result(request.transactionId, 'injected'), continuation: await advanceLiveChain(deps, session, pending.chain, pending.request) };
  } catch { return result(request.transactionId, 'provider-unavailable'); }
  finally { void deps.cancelDeferred?.(pending.tabId, pending.pendingId).catch(() => undefined); }
}
function alive(pending: PendingDeferredSubmit): boolean { return Date.now() < pending.expiresAt && performance.now() < pending.deadline && Date.now() < pending.chain.expiresAt; }
