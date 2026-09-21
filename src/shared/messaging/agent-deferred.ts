import { AGENT_INJECT_PROTOCOL, isRecord, onlyKeys, validIdentifier, validTargetUrl, validExpectedDomain, validExpiry,
  parseAgentInjectForm, parseAgentInjectValues, type AgentInjectForm, type AgentInjectFieldValue, type AgentInjectFailure } from './agent-inject';
export const DEFERRED_FILL = 'palladin.agent-live/deferred-fill';
export const DEFERRED_COMMIT = 'palladin.agent-live/deferred-commit';
export const DEFERRED_CANCEL = 'palladin.agent-live/deferred-cancel';
const ID = /^[a-f0-9]{32}$/;
export interface SubmitReady { readonly pendingId: string; readonly currentUrl: string; readonly documentId: string; readonly submitSelector: string }
export interface DeferredSubmitRequest {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL; readonly type: 'submit'; readonly transactionId: string;
  readonly preparedTransactionId: string; readonly grantId: string; readonly entryId: string; readonly expectedDomain: string;
  readonly expiresAt: number; readonly submitReady: SubmitReady;
}
export interface DeferredCancelRequest {
  readonly protocol: typeof AGENT_INJECT_PROTOCOL; readonly type: 'cancel-submit'; readonly transactionId: string;
  readonly preparedTransactionId: string; readonly pendingId: string;
}
export interface DeferredFillMessage {
  readonly channel: typeof DEFERRED_FILL; readonly pendingId: string; readonly documentId: string; readonly expectedDomain: string;
  readonly form: AgentInjectForm; readonly values: readonly AgentInjectFieldValue[]; readonly expiresAt: number;
  readonly requireExistingUsername?: true;
  /** Private worker-issued epoch; present only on the first native flow stage. */
  readonly automaticFillSessionId?: string;
}
export interface DeferredCommitMessage { readonly channel: typeof DEFERRED_COMMIT; readonly expectedDomain: string; readonly expiresAt: number; readonly submitReady: SubmitReady }
export type DeferredFillOutcome = { readonly ok: true; readonly submitReady: SubmitReady } | { readonly ok: false; readonly outcome: AgentInjectFailure };
export function parseSubmitReady(raw: unknown): SubmitReady | null {
  if (!isRecord(raw) || !onlyKeys(raw, ['pendingId', 'currentUrl', 'documentId', 'submitSelector'])
    || typeof raw.pendingId !== 'string' || !ID.test(raw.pendingId)
    || typeof raw.documentId !== 'string' || !ID.test(raw.documentId) || !validTargetUrl(raw.currentUrl)
    || typeof raw.submitSelector !== 'string' || !/^palladin-live:[a-f0-9]{32}:[a-f0-9]{32}$/.test(raw.submitSelector) || raw.submitSelector.split(':')[1] !== raw.pendingId) return null;
  return raw as unknown as SubmitReady;
}
export function parseDeferredSubmit(raw: unknown): DeferredSubmitRequest | null {
  if (!isRecord(raw) || !onlyKeys(raw, ['protocol','type','transactionId','preparedTransactionId','grantId','entryId','expectedDomain','expiresAt','submitReady'])
    || raw.protocol !== AGENT_INJECT_PROTOCOL || raw.type !== 'submit' || !validIdentifier(raw.transactionId)
    || !validIdentifier(raw.preparedTransactionId) || !validIdentifier(raw.grantId) || !validIdentifier(raw.entryId)
    || !validExpectedDomain(raw.expectedDomain) || !validExpiry(raw.expiresAt) || !parseSubmitReady(raw.submitReady)) return null;
  return raw as unknown as DeferredSubmitRequest;
}
export function parseDeferredCancel(raw: unknown): DeferredCancelRequest | null {
  if (!isRecord(raw) || !onlyKeys(raw, ['protocol','type','transactionId','preparedTransactionId','pendingId'])
    || raw.protocol !== AGENT_INJECT_PROTOCOL || raw.type !== 'cancel-submit' || !validIdentifier(raw.transactionId)
    || !validIdentifier(raw.preparedTransactionId) || typeof raw.pendingId !== 'string' || !ID.test(raw.pendingId)) return null;
  return raw as unknown as DeferredCancelRequest;
}
export function isDeferredFillMessage(raw: unknown): raw is DeferredFillMessage {
  if (!isRecord(raw) || !onlyKeys(raw, ['channel','pendingId','documentId','expectedDomain','form','values','expiresAt','requireExistingUsername','automaticFillSessionId'])
    || raw.channel !== DEFERRED_FILL || typeof raw.pendingId !== 'string' || !ID.test(raw.pendingId) || typeof raw.documentId !== 'string' || !ID.test(raw.documentId)
    || !validExpectedDomain(raw.expectedDomain) || !validExpiry(raw.expiresAt)
    || (raw.requireExistingUsername !== undefined && raw.requireExistingUsername !== true)
    || (raw.automaticFillSessionId !== undefined && (typeof raw.automaticFillSessionId !== 'string'
      || !ID.test(raw.automaticFillSessionId) || raw.requireExistingUsername === true))) return false;
  const form = parseAgentInjectForm(raw.form);
  return form?.version === 2 && parseAgentInjectValues(raw.values, form) !== null;
}
export function isDeferredCommitMessage(raw: unknown): raw is DeferredCommitMessage {
  return isRecord(raw) && onlyKeys(raw, ['channel','expectedDomain','expiresAt','submitReady']) && raw.channel === DEFERRED_COMMIT
    && validExpectedDomain(raw.expectedDomain) && validExpiry(raw.expiresAt) && parseSubmitReady(raw.submitReady) !== null;
}
export function isDeferredCancelMessage(raw: unknown): raw is { channel: typeof DEFERRED_CANCEL; pendingId: string } {
  return isRecord(raw) && onlyKeys(raw,['channel','pendingId']) && raw.channel === DEFERRED_CANCEL && typeof raw.pendingId === 'string' && ID.test(raw.pendingId);
}
export function sameSubmitReady(left: SubmitReady, right: SubmitReady): boolean {
  return left.pendingId === right.pendingId && left.currentUrl === right.currentUrl && left.documentId === right.documentId && left.submitSelector === right.submitSelector;
}
