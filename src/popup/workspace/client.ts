import type { MemberIdentity } from '../../shared/workspace/contracts';
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
  const invalidate = (types: readonly WorkspaceListType[], notify = true) => {
    for (const [key, item] of lists) if (types.includes(item.type)) lists.delete(key);
    if (notify) for (const listener of listeners) listener(types);
  };
  let directory: Promise<MemberIdentity[]> | null = null;
  let repaired = false;
  const readDirectory = async () => {
    const response = await send({ type: 'workspace/members' });
    if (!response?.ok || !response.data || !('items' in response.data))
      throw new Error('network');
    return response.data.items as MemberIdentity[];
  };
  return {
    invalidate,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async members(visibleUserIds) {
      directory ??= readDirectory().catch(() => []);
      const current = await directory;
      const known = new Set(current.map((member) => member.userId));
      if (!repaired && visibleUserIds.some((id) => !known.has(id))) {
        repaired = true;
        directory = readDirectory().catch(() => current);
      }
      return directory;
    },
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
