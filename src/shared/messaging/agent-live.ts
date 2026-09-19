import { parseAgentInjectForm, type AgentInjectForm, type AgentInjectFormStep } from './agent-inject';
/** Private worker-to-isolated-world discovery; no page values are returned. */
export const AGENT_LIVE_INSPECT_CHANNEL = 'palladin.agent-live/inspect';
export const AGENT_LIVE_PROBE_CHANNEL = 'palladin.agent-live/probe';
export type LiveLoginProbe = { readonly outcome: 'ready'; readonly form: AgentInjectForm }
  | { readonly outcome: 'challenge' } | { readonly outcome: 'no-form' };
export type LiveContinuation = { readonly outcome: 'ready'; readonly currentUrl: string; readonly documentId: string; readonly liveForm: AgentInjectForm }
  | { readonly outcome: 'challenge' | 'no-form' | 'timeout' | 'origin-mismatch' | 'insecure-origin' | 'provider-unavailable' };
export function parseLiveLoginProbe(raw: unknown): LiveLoginProbe | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.outcome === 'no-form' || item.outcome === 'challenge') return Object.keys(item).length === 1 ? { outcome: item.outcome } : null;
  if (item.outcome !== 'ready' || Object.keys(item).length !== 2) return null;
  const form = parseAgentInjectForm(item.form);
  return form && form.steps.length === 1 ? { outcome: 'ready', form } : null;
}
export function isLiveProbeMessage(value: unknown): value is { channel: typeof AGENT_LIVE_PROBE_CHANNEL; documentId: string; targetUrl: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return isLiveInspectMessage({ ...value, channel: AGENT_LIVE_INSPECT_CHANNEL })
    && 'channel' in value && value.channel === AGENT_LIVE_PROBE_CHANNEL;
}
export function isLiveInspectMessage(value: unknown): value is { channel: typeof AGENT_LIVE_INSPECT_CHANNEL; documentId: string; targetUrl: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['channel', 'documentId', 'targetUrl'].includes(key))
    && item.channel === AGENT_LIVE_INSPECT_CHANNEL && typeof item.documentId === 'string'
    && /^[a-f0-9]{32}$/.test(item.documentId) && typeof item.targetUrl === 'string' && item.targetUrl.length <= 4096;
}

export function sameLiveStep(left: AgentInjectFormStep, right: AgentInjectFormStep): boolean {
  return left.waitFor === undefined && right.waitFor === undefined
    && left.submit.action === right.submit.action && left.submit.selector === right.submit.selector
    && left.fields.length === right.fields.length && left.fields.every((field, index) => {
      const other = right.fields[index];
      return other !== undefined && field.entryFieldId === other.entryFieldId
        && field.selector === other.selector && field.control === other.control;
    });
}
export function sameLiveForm(left: AgentInjectForm, right: AgentInjectForm): boolean {
  return left.version === right.version && left.steps.length === 1 && right.steps.length === 1
    && sameLiveStep(left.steps[0]!, right.steps[0]!);
}
