/** Native-only capture contract; never part of the page-world bridge vocabulary. */
import { AGENT_INJECT_PROTOCOL, isRecord, onlyKeys, validIdentifier, validTargetUrl } from './agent-inject';
export const CAPTURE_FIELD_BYTES = 65536;
export const CAPTURE_TOTAL_BYTES = 262144;
export const AGENT_CAPTURE_CHANNEL = 'palladin.agent-capture/read' as const;
export interface AgentCaptureField { readonly entryFieldId: string; readonly selector: string; readonly read: 'value' | 'textContent' }
export interface AgentCaptureValue { readonly entryFieldId: string; value: string }
export interface AgentCaptureRequest { readonly protocol: typeof AGENT_INJECT_PROTOCOL; readonly type: 'capture'; readonly transactionId: string; readonly targetUrl: string; readonly fields: readonly AgentCaptureField[] }
export interface AgentCaptureMessage { readonly channel: typeof AGENT_CAPTURE_CHANNEL; readonly documentId: string; readonly targetUrl: string; readonly fields: readonly AgentCaptureField[] }
export type AgentCaptureOutcome = { readonly outcome: 'captured'; readonly values: AgentCaptureValue[] } | { readonly outcome: 'rejected' | 'provider-unavailable' };
export type AgentCaptureResult = AgentCaptureOutcome & { readonly protocol: typeof AGENT_INJECT_PROTOCOL; readonly type: 'capture.result'; readonly transactionId: string | null };
const fieldId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function validFields(value: unknown): value is AgentCaptureField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return false;
  const ids = new Set<string>(), selectors = new Set<string>();
  for (const field of value) {
    if (!isRecord(field) || !onlyKeys(field, ['entryFieldId', 'selector', 'read']) || !fieldId(field.entryFieldId)
      || typeof field.selector !== 'string' || field.selector.length < 1 || field.selector.length > 1024
      || field.selector !== field.selector.trim() || field.selector.includes('\0')
      || !['value', 'textContent'].includes(String(field.read)) || ids.has(field.entryFieldId) || selectors.has(field.selector)) return false;
    ids.add(field.entryFieldId); selectors.add(field.selector);
  }
  return true;
}
export function parseAgentCaptureRequest(value: unknown): AgentCaptureRequest | null {
  return isRecord(value) && onlyKeys(value, ['protocol', 'type', 'transactionId', 'targetUrl', 'fields'])
    && value.protocol === AGENT_INJECT_PROTOCOL && value.type === 'capture' && validIdentifier(value.transactionId)
    && validTargetUrl(value.targetUrl) && validFields(value.fields) ? value as unknown as AgentCaptureRequest : null;
}
export function isAgentCaptureMessage(value: unknown): value is AgentCaptureMessage {
  return isRecord(value) && onlyKeys(value, ['channel', 'documentId', 'targetUrl', 'fields']) && value.channel === AGENT_CAPTURE_CHANNEL
    && typeof value.documentId === 'string' && /^[a-f0-9]{32}$/.test(value.documentId) && validTargetUrl(value.targetUrl) && validFields(value.fields);
}
export function isAgentCaptureOutcome(value: unknown): value is AgentCaptureOutcome {
  if (!isRecord(value)) return false;
  if (value.outcome !== 'captured') return onlyKeys(value, ['outcome']) && ['rejected', 'provider-unavailable'].includes(String(value.outcome));
  if (!onlyKeys(value, ['outcome', 'values']) || !Array.isArray(value.values) || value.values.length < 1 || value.values.length > 32) return false;
  let total = 0;
  const ids = new Set<string>();
  for (const field of value.values) {
    if (!isRecord(field) || !onlyKeys(field, ['entryFieldId', 'value']) || !fieldId(field.entryFieldId) || ids.has(field.entryFieldId) || typeof field.value !== 'string' || field.value.length > CAPTURE_FIELD_BYTES) return false;
    ids.add(field.entryFieldId);
    const encoded = new TextEncoder().encode(field.value);
    const length = encoded.byteLength;
    encoded.fill(0);
    total += length;
    if (length > CAPTURE_FIELD_BYTES || total > CAPTURE_TOTAL_BYTES) return false;
  }
  return true;
}
export function wipeCaptureOutcome(value: AgentCaptureOutcome | null): void {
  if (value?.outcome === 'captured') for (const field of value.values) field.value = '';
}
