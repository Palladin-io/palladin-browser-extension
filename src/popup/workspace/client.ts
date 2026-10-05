import { buildId } from '../../shared/config/build-identity';
import type { MemberIdentity } from '../../shared/workspace/contracts';
import type {
  WorkspaceCommand,
  WorkspaceReply,
  WorkspaceResults,
} from '../../shared/workspace/commands';

export class WorkspaceClientError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); }
}

export interface WorkspaceClient {
  members(visibleUserIds: readonly string[]): Promise<MemberIdentity[]>;
  send<C extends WorkspaceCommand>(
    command: C,
  ): Promise<WorkspaceResults[C['type']]>;
}
export function createWorkspaceClient(
  transport?: (command: WorkspaceCommand) => Promise<WorkspaceReply | undefined>,
): WorkspaceClient {
  let compatible: Promise<void> | null = null;
  const send = transport ?? (async (command: WorkspaceCommand) => {
    if (typeof chrome === 'undefined') throw new WorkspaceClientError('worker');
    compatible ??= chrome.runtime.sendMessage({ type: 'workspace/build' }).then((reply: WorkspaceReply | undefined) => {
      if (!reply?.ok || !reply.data || !('buildId' in reply.data) || reply.data.buildId !== buildId) {
        throw new WorkspaceClientError('reload');
      }
    });
    await compatible;
    return chrome.runtime.sendMessage(command) as Promise<WorkspaceReply | undefined>;
  });
  let directory: Promise<MemberIdentity[]> | null = null;
  let repaired = false;
  const readDirectory = async () => {
    const response = await send({ type: 'workspace/members' });
    if (!response?.ok || !response.data || !('items' in response.data))
      throw new Error('network');
    return response.data.items as MemberIdentity[];
  };
  return {
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
      const response = await send(command).catch(error => { throw error instanceof WorkspaceClientError ? error : new WorkspaceClientError('worker'); });
      if (!response?.ok) throw new WorkspaceClientError(response?.code ?? 'worker', response?.httpStatus);
      return response.data as WorkspaceResults[C['type']];
    },
  };
}
