import type { AgentIdentity, MemberIdentity } from '../../shared/workspace/contracts';
import type {
  WorkspaceCommand,
  WorkspaceReply,
  WorkspaceResults,
} from '../../shared/workspace/commands';

export class WorkspaceClientError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); }
}

export const WORKSPACE_LIST_TTL_MS = 60_000;
export type WorkspaceListType = 'workspace/grants' | 'workspace/audit' | 'workspace/shares' | 'workspace/my-shares';
const listTypes = new Set<string>(['workspace/grants', 'workspace/audit', 'workspace/shares', 'workspace/my-shares']);

export interface WorkspaceClient {
  invalidate?(types: readonly WorkspaceListType[], notify?: boolean): void;
  subscribe?(listener: (types: readonly WorkspaceListType[]) => void): () => void;
  members(visibleUserIds: readonly string[]): Promise<MemberIdentity[]>;
  agents(visibleAgentIds: readonly string[]): Promise<AgentIdentity[]>;
  send<C extends WorkspaceCommand>(
    command: C,
  ): Promise<WorkspaceResults[C['type']]>;
}
export function createWorkspaceClient(
  transport?: (command: WorkspaceCommand) => Promise<WorkspaceReply | undefined>,
): WorkspaceClient {
  const send = transport ?? (async (command: WorkspaceCommand) => {
    if (typeof chrome === 'undefined') throw new WorkspaceClientError('worker');
    return chrome.runtime.sendMessage(command) as Promise<WorkspaceReply | undefined>;
  });
  const lists = new Map<string, { type: WorkspaceListType; expires: number; result: Promise<WorkspaceResults[WorkspaceListType]> }>();
  const listeners = new Set<(types: readonly WorkspaceListType[]) => void>();
  const members = directory(async () => {
    const response = await send({ type: 'workspace/members' });
    if (!response?.ok || !response.data || !('items' in response.data))
      throw new Error('network');
    return response.data.items as MemberIdentity[];
  }, (member) => member.userId);
  const agents = directory(async () => {
    const response = await send({ type: 'workspace/agents' });
    if (!response?.ok || !response.data || !('items' in response.data))
      throw new Error('network');
    return response.data.items as AgentIdentity[];
  }, (agent) => agent.agentId);
  const invalidate = (types: readonly WorkspaceListType[], notify = true) => {
    for (const [key, item] of lists) if (types.includes(item.type)) lists.delete(key);
    // New audit rows can reference principals created after the directories were read.
    if (types.includes('workspace/audit')) { members.allowRepair(); agents.allowRepair(); }
    if (notify) for (const listener of listeners) listener(types);
  };
  return {
    invalidate,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    members: members.resolve,
    agents: agents.resolve,
    async send<C extends WorkspaceCommand>(
      command: C,
    ): Promise<WorkspaceResults[C['type']]> {
      const cacheable = listTypes.has(command.type);
      const key = JSON.stringify(Object.entries(command).sort(([a], [b]) => a.localeCompare(b)));
      const cached = cacheable ? lists.get(key) : undefined;
      if (cached && cached.expires > Date.now()) return cached.result as Promise<WorkspaceResults[C['type']]>;
      const request = async (): Promise<WorkspaceResults[C['type']]> => {
        const response = await send(command).catch(error => { throw error instanceof WorkspaceClientError ? error : new WorkspaceClientError('worker'); });
        if (!response?.ok) throw new WorkspaceClientError(response?.code ?? 'worker', response?.httpStatus);
        if (['workspace/approve-grant', 'workspace/deny', 'workspace/revoke-grant'].includes(command.type))
          invalidate(['workspace/grants', 'workspace/audit']);
        if (['workspace/create-share', 'workspace/revoke-share', 'workspace/protect-share'].includes(command.type))
          invalidate(['workspace/shares', 'workspace/my-shares', 'workspace/audit']);
        return response.data as WorkspaceResults[C['type']];
      };
      if (!cacheable) return request();
      // Bound session memory even when many filters and cursor pages are visited.
      if (lists.size >= 100) lists.delete(lists.keys().next().value!);
      const item = { type: command.type as WorkspaceListType, expires: Infinity,
        result: request() as Promise<WorkspaceResults[WorkspaceListType]> };
      lists.set(key, item);
      item.result = item.result.then(value => {
        item.expires = Date.now() + WORKSPACE_LIST_TTL_MS;
        return value;
      }, error => {
        if (lists.get(key) === item) lists.delete(key);
        throw error;
      });
      return item.result as Promise<WorkspaceResults[C['type']]>;
    },
  };
}

/** One memory-only directory per popup client; unknown visible IDs trigger at most one whole-directory repair per audit invalidation. */
function directory<T>(read: () => Promise<T[]>, idOf: (item: T) => string) {
  let current: Promise<T[]> | null = null;
  let repaired = false;
  return {
    allowRepair() { repaired = false; },
    async resolve(visibleIds: readonly string[]): Promise<T[]> {
      current ??= read().catch(() => []);
      const loaded = await current;
      const known = new Set(loaded.map(idOf));
      if (!repaired && visibleIds.some((id) => !known.has(id))) {
        repaired = true;
        current = read().catch(() => loaded);
      }
      return current;
    },
  };
}
