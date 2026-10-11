import { AGENT_INJECT_PROTOCOL, parseAgentPrepareRequest } from '@shared/messaging';
import type { AgentFillDeps } from './native-provider';

export type TargetProbeOutcome = 'match' | 'no-match' | 'unavailable';
export interface TargetProbeResult {
  protocol: typeof AGENT_INJECT_PROTOCOL;
  type: 'target.probe.result';
  nonce: string;
  outcome: TargetProbeOutcome;
}

export async function probeTarget(deps: AgentFillDeps, raw: Record<string, unknown>): Promise<TargetProbeResult> {
  if (Object.keys(raw).some(key => !['protocol', 'type', 'nonce', 'targetTabId', 'targetUrl'].includes(key))) {
    throw new Error('Invalid target probe');
  }
  const request = parseAgentPrepareRequest({ ...raw, type: 'prepare' });
  if (raw.type !== 'target.probe' || !request || request.targetTabId === undefined || request.targetUrl === undefined) {
    throw new Error('Invalid target probe');
  }
  let outcome: TargetProbeOutcome = 'unavailable';
  try { outcome = await deps.probeTarget?.(request.targetTabId, request.targetUrl) ?? 'unavailable'; } catch { /* No browser exception text crosses the protocol. */ }
  return { protocol: AGENT_INJECT_PROTOCOL, type: 'target.probe.result', nonce: request.nonce, outcome };
}
