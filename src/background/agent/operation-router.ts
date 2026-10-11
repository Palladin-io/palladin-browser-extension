import { probeTarget, type TargetProbeResult } from './target-probe';
import { AGENT_INJECT_PROTOCOL, parseAgentPrepareRequest } from '@shared/messaging';
import { gateAgentFillDeps } from './gated-deps';
import { cancelPendingDeferred } from './native-deferred';
import { handleNativeAgentMessage, wipeAgentMessageValues, type AgentFillDeps, type AgentProviderSession, type TransactionReplayGuard } from './native-provider';

type ProviderReply = Awaited<ReturnType<typeof handleNativeAgentMessage>>;
export type OperationReply = {
  protocol: typeof AGENT_INJECT_PROTOCOL;
  type: 'operation.result';
  operationId: string;
  response: ProviderReply | TargetProbeResult;
} | {
  protocol: typeof AGENT_INJECT_PROTOCOL;
  type: 'operation.closed';
  operationId: string;
};

interface Operation {
  tabId: number | null;
  readonly session: AgentProviderSession;
  readonly deps: AgentFillDeps;
  active: boolean;
  pending: Promise<ProviderReply | TargetProbeResult> | null;
  closing?: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

// Covers the host's five-minute approval wait plus transport/cleanup margin.
const OPERATION_LIFETIME_MS = 360_000;
const MAX_OPERATIONS = 32;

/** One authenticated native connection; ownership is reserved before DOM lookup. */
export class NativeOperationRouter {
  private readonly operations = new Map<string, Operation>();
  private readonly tabs = new Map<number, string>();
  private disposed = false;

  constructor(private readonly deps: AgentFillDeps, private readonly replay: TransactionReplayGuard) {}

  async dispatch(raw: unknown): Promise<OperationReply> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid operation envelope');
    const message = raw as Record<string, unknown>;
    const { operationId, request } = message;
    const close = message.type === 'operation.close';
    if (this.disposed || message.protocol !== AGENT_INJECT_PROTOCOL
      || (!close && message.type !== 'operation.request')
      || typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)
      || Object.keys(message).some(key => !['protocol', 'type', 'operationId', ...(close ? [] : ['request'])].includes(key))) {
      wipeAgentMessageValues(request);
      throw new Error('Invalid operation envelope');
    }
    if (close) {
      await this.close(operationId);
      return { protocol: AGENT_INJECT_PROTOCOL, type: 'operation.closed', operationId };
    }
    const reply = (response: ProviderReply | TargetProbeResult): OperationReply => ({ protocol: AGENT_INJECT_PROTOCOL, type: 'operation.result', operationId, response });
    if (typeof request === 'object' && request !== null && 'type' in request && request.type === 'target.probe') {
      try {
        if (this.operations.has(operationId)) throw new Error('Probe cannot reuse an operation');
        if (this.operations.size >= MAX_OPERATIONS) throw new Error('Operation capacity exceeded');
        const operation = this.createOperation(operationId, null);
        const pending = probeTarget(operation.deps, request as Record<string, unknown>);
        operation.pending = pending;
        try { return reply(await pending); }
        finally { operation.pending = null; }
      } finally { wipeAgentMessageValues(request); }
    }
    const prepare = parseAgentPrepareRequest(request);
    let operation = this.operations.get(operationId);
    if (!operation) {
      if (!prepare) {
        wipeAgentMessageValues(request);
        return reply({ protocol: AGENT_INJECT_PROTOCOL, type: 'inject.result', transactionId: null, outcome: 'rejected' });
      }
      const occupied = prepare.targetTabId !== undefined && this.tabs.has(prepare.targetTabId);
      if (occupied || this.operations.size >= MAX_OPERATIONS) {
        return reply({ protocol: AGENT_INJECT_PROTOCOL, type: 'prepare.result', nonce: prepare.nonce,
          currentUrl: null, outcome: occupied ? 'target-tab-busy' : 'provider-unavailable' });
      }
      operation = this.createOperation(operationId, prepare.targetTabId ?? null);
    } else if (!operation.active || operation.pending || prepare) {
      // A caller cannot retarget or overlap messages within one operation.
      wipeAgentMessageValues(request);
      throw new Error('Operation message order violated');
    }
    const current = operation;
    const pending = this.execute(current, operationId, request, prepare);
    current.pending = pending;
    try {
      return reply(await pending);
    } finally {
      wipeAgentMessageValues(request);
      current.pending = null;
    }
  }

  private createOperation(operationId: string, tabId: number | null): Operation {
    const state: Operation = {
      tabId, session: { prepared: null }, active: true, pending: null,
      deps: gateAgentFillDeps(this.deps, () => state.active && !this.disposed),
      timer: setTimeout(() => { void this.close(operationId); }, OPERATION_LIFETIME_MS),
    };
    this.operations.set(operationId, state);
    if (tabId !== null) this.tabs.set(tabId, operationId);
    return state;
  }

  private async execute(operation: Operation, operationId: string, request: unknown,
    prepare: ReturnType<typeof parseAgentPrepareRequest>): Promise<ProviderReply> {
    if (prepare && operation.tabId === null) {
      // Preserve the pre-existing CLI mode that deliberately omits a target.
      // Resolve it once; an explicit target never enters this branch.
      const tab = await operation.deps.getActivePage();
      if (!tab?.page || !operation.active || this.disposed) {
        return { protocol: AGENT_INJECT_PROTOCOL, type: 'prepare.result', nonce: prepare.nonce, currentUrl: null, outcome: 'provider-unavailable' };
      }
      if (this.tabs.has(tab.id)) {
        return { protocol: AGENT_INJECT_PROTOCOL, type: 'prepare.result', nonce: prepare.nonce, currentUrl: null, outcome: 'target-tab-busy' };
      }
      operation.tabId = tab.id;
      this.tabs.set(tab.id, operationId);
      request = { ...prepare, targetTabId: tab.id, targetUrl: tab.page.url };
    }
    return handleNativeAgentMessage(operation.deps, this.replay, operation.session, request);
  }

  close(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) return Promise.resolve();
    if (operation.closing) return operation.closing;
    operation.active = false;
    clearTimeout(operation.timer);
    operation.closing = this.finishClose(operationId, operation);
    return operation.closing;
  }

  private async finishClose(operationId: string, operation: Operation): Promise<void> {
    await cancelPendingDeferred(operation.deps, operation.session);
    // Keep the reservation while an already-started page operation settles.
    await operation.pending?.catch(() => undefined);
    await cancelPendingDeferred(operation.deps, operation.session);
    operation.session.prepared = null;
    operation.session.liveChain = null;
    delete operation.session.boundDeps;
    if (this.operations.get(operationId) === operation) {
      this.operations.delete(operationId);
      if (operation.tabId !== null) this.tabs.delete(operation.tabId);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.operations.keys()].map(operationId => this.close(operationId)));
  }
}
