import type { AgentInjectionRequest } from '@shared/messaging';
import type { LiveContinuation } from '@shared/messaging/agent-live';
import type { AgentFillDeps, AgentProviderSession, PreparedAgentPage } from './native-provider';

export interface LiveChain {
  readonly origin: string;
  readonly tabId: number;
  readonly grantId: string;
  readonly entryId: string;
  readonly expectedDomain: string;
  readonly expiresAt: number;
  readonly submitted: Set<string>;
  steps: number;
}

/** A continuation never upgrades the authenticated Entry host or selects a tab. */
export function bindLiveChain(prepared: PreparedAgentPage, previous: LiveChain | null | undefined, request: AgentInjectionRequest): LiveChain | null {
  if (!prepared.liveForm || !prepared.liveOrigin || request.form.steps.length !== 1) return null;
  const fields = request.form.steps[0]!.fields;
  if (fields.some(field => !['credential.username', 'credential.password', 'credential.totp'].includes(field.entryFieldId))) return null;
  if (previous) return previous.tabId === prepared.tabId && previous.origin === prepared.liveOrigin
    && previous.grantId === request.grantId && previous.entryId === request.entryId && previous.expectedDomain === request.expectedDomain
    && previous.steps < 8 && Date.now() < previous.expiresAt && hasFreshStage(fields, previous.submitted) ? previous : null;
  return { origin: prepared.liveOrigin, tabId: prepared.tabId, grantId: request.grantId, entryId: request.entryId,
    expectedDomain: request.expectedDomain, expiresAt: Date.now() + 60_000, steps: 0, submitted: new Set() };
}

export async function advanceLiveChain(deps: AgentFillDeps, session: AgentProviderSession, chain: LiveChain, request: AgentInjectionRequest): Promise<LiveContinuation> {
  for (const field of request.form.steps[0]!.fields) chain.submitted.add(field.entryFieldId);
  chain.steps++;
  const stop = (outcome: Exclude<LiveContinuation['outcome'], 'ready'>): LiveContinuation => {
    session.prepared = null; session.liveChain = null; return { outcome };
  };
  if (!deps.probeLiveLogin) return stop('provider-unavailable');
  let absent = 0;
  let absentDocument = '';
  let absentSince = 0;
  const deadline = Math.min(Date.now() + 10_000, chain.expiresAt);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (Date.now() >= deadline || chain.steps >= 8) return stop('timeout');
      await wait(100);
      const tab = await deps.getPageById(chain.tabId);
      if (!tab || tab.id !== chain.tabId) return stop('provider-unavailable');
      if (!tab.page) { absent = 0; continue; }
      const url = new URL(tab.page.url);
      if (url.protocol !== 'https:') return stop('insecure-origin');
      if (url.origin !== chain.origin) return stop('origin-mismatch');
      const report = await deps.probeLiveLogin(chain.tabId, tab.page.documentId, tab.page.url);
      const after = await deps.getPageById(chain.tabId);
      if (Date.now() >= deadline) return stop('timeout');
      if (!after || after.id !== chain.tabId) return stop('provider-unavailable');
      if (!after.page || after.page.documentId !== tab.page.documentId || after.page.url !== tab.page.url) { absent = 0; continue; }
      if (!report) { absent = 0; continue; }
      if (report.outcome === 'challenge') return stop('challenge');
      if (report.outcome === 'no-form') {
        const document = `${tab.page.documentId}\n${tab.page.url}`;
        if (absent === 0 || document !== absentDocument) {
          absent = 0;
          absentSince = performance.now();
        }
        absent++;
        absentDocument = document;
        // IPC latency varies: require elapsed stable absence, not twenty round trips.
        // Fresh observations are terminal evidence of no form, never authentication proof.
        if (absent >= 2 && performance.now() - absentSince >= 2_000) return stop('no-form');
        continue;
      }
      absent = 0;
      if (report.form.version !== 1 && report.form.version !== 2) return stop('challenge');
      const fields = report.form.steps[0]?.fields;
      if (report.form.steps.length !== 1 || !fields?.length
        || fields.some(field => !['credential.username', 'credential.password', 'credential.totp'].includes(field.entryFieldId))) return stop('challenge');
      // Fresh opaque refs alone do not make an already-submitted stage new.
      if (!hasFreshStage(fields, chain.submitted)) continue;
      if (Date.now() >= chain.expiresAt) return stop('timeout');
      session.liveChain = chain;
      session.prepared = { tabId: chain.tabId, documentId: tab.page.documentId, liveForm: report.form,
        requireExistingUsername: chain.submitted.has('credential.username') && fields.some(field => field.entryFieldId === 'credential.username'),
        liveOrigin: chain.origin, liveExpiresAt: chain.expiresAt };
      return { outcome: 'ready', currentUrl: tab.page.url, documentId: tab.page.documentId, liveForm: report.form };
    }
    return stop('timeout');
  } catch { return stop('provider-unavailable'); }
}

/** Identifier can remain alongside a newly requested password. The runtime
 * supplies the approved identifier again for equality checking, not an overwrite.
 * Repeated password/OTP delivery or a stage with no new field never progresses. */
function hasFreshStage(fields: readonly { entryFieldId: string }[], submitted: ReadonlySet<string>): boolean {
  const newPassword = fields.some(field => field.entryFieldId === 'credential.password' && !submitted.has(field.entryFieldId));
  return fields.some(field => !submitted.has(field.entryFieldId))
    && fields.every(field => !submitted.has(field.entryFieldId) || (field.entryFieldId === 'credential.username' && newPassword));
}
