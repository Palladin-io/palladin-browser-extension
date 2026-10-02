import { validShareProtection } from '../../shared/workspace/sharing-input';
import {
  workspaceCommandSchema,
  type WorkspaceCommand,
  type WorkspaceErrorCode,
  type WorkspaceReply,
} from '../../shared/workspace/commands';

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
  }
}
export interface WorkspaceSession {
  getKeys(): object | null;
  getAccessToken(): Promise<string | null>;
  refreshAccessToken(): Promise<string | null>;
}
export interface WorkspaceOperation {
  signal: AbortSignal;
  assertCurrent(): void;
  request(path: string, method: string, body?: object): Promise<unknown>;
}
export interface WorkspaceDependencies {
  actions?: {
    handle(
      command: WorkspaceCommand,
      operation: WorkspaceOperation,
    ): Promise<WorkspaceReply | null>;
    clear(): void;
  };
  session: WorkspaceSession;
  apiUrl(): string;
  fetch: typeof fetch;
}

export class WorkspaceService {
  private readonly pending = new Set<AbortController>();
  constructor(private readonly deps: WorkspaceDependencies) {}

  lock(): void {
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    this.deps.actions?.clear();
  }

  async handle(raw: unknown): Promise<WorkspaceReply | null> {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('type' in raw) ||
      typeof raw.type !== 'string' ||
      !raw.type.startsWith('workspace/')
    )
      return null;
    const parsed = workspaceCommandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid' };
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      const command = parsed.data;
      if (
        (command.type === 'workspace/create-share' ||
          command.type === 'workspace/protect-share') &&
        !validShareProtection(command.protection, command.protectionSecret)
      )
        throw new WorkspaceError('invalid');
      const keys = this.deps.session.getKeys(),
        apiUrl = this.deps.apiUrl();
      const assertCurrent = () => {
        if (
          !keys ||
          this.deps.session.getKeys() !== keys ||
          this.deps.apiUrl() !== apiUrl ||
          controller.signal.aborted
        )
          throw new WorkspaceError('locked');
      };
      assertCurrent();
      const action = await this.deps.actions?.handle(command, {
        assertCurrent,
        signal: controller.signal,
        request: async (path, method, body) => {
          assertCurrent();
          const result = await this.request(path, method, body);
          assertCurrent();
          return result;
        },
      });
      if (action) {
        assertCurrent();
        return action;
      }
      const route = this.route(command);
      const data = await this.request(route.path, route.method, route.body);
      return {
        ok: true,
        data: (route.method === 'GET' ? data : null) as Extract<
          WorkspaceReply,
          { ok: true }
        >['data'],
      };
    } catch (error) {
      return {
        ok: false,
        code: controller.signal.aborted
          ? 'locked'
          : error instanceof WorkspaceError
            ? error.code
            : 'network',
      };
    } finally {
      this.pending.delete(controller);
    }
  }

  private route(command: WorkspaceCommand): {
    path: string;
    method: string;
    body?: object;
  } {
    const query = (values: Record<string, string | undefined>) => {
      const params = new URLSearchParams({ pageSize: '30' });
      for (const [key, value] of Object.entries(values))
        if (value) params.set(key, value);
      return params.toString();
    };
    switch (command.type) {
      case 'workspace/review-grant':
      case 'workspace/approve-grant':
      case 'workspace/detail':
      case 'workspace/field':
      case 'workspace/create-share':
      case 'workspace/discard-share':
        throw new WorkspaceError('invalid');
      case 'workspace/grants':
        return {
          path: `/api/grants?${query({ cursor: command.cursor, status: command.status, entryId: command.entryId, vaultId: command.vaultId })}`,
          method: 'GET',
        };
      case 'workspace/audit':
        return {
          path: `/api/audit-logs?${query({ cursor: command.cursor, entryId: command.entryId, vaultId: command.vaultId, eventType: command.eventType })}`,
          method: 'GET',
        };
      case 'workspace/members':
        return { path: '/api/organization/member-directory', method: 'GET' };
      case 'workspace/deny':
        return {
          path: `/api/vaults/${command.vaultId}/grants/${command.grantId}/deny`,
          method: 'PUT',
          body: command.reason ? { reason: command.reason } : {},
        };
      case 'workspace/revoke-grant':
        return {
          path: `/api/vaults/${command.vaultId}/grants/${command.grantId}`,
          method: 'DELETE',
          body: {},
        };
      case 'workspace/shares':
        return {
          path: `${this.sharingPath(command)}?${query({ cursor: command.cursor })}`,
          method: 'GET',
        };
      case 'workspace/revoke-share':
        return {
          path: `${this.sharingPath(command)}/${command.shareId}`,
          method: 'DELETE',
        };
      case 'workspace/protect-share':
        return {
          path: `${this.sharingPath(command)}/${command.shareId}/protection`,
          method: 'PUT',
          body: {
            protection: command.protection,
            protectionSecret: command.protectionSecret,
          },
        };
    }
  }

  private sharingPath(scope: { vaultId: string; entryId: string }): string {
    return `/api/vaults/${scope.vaultId}/entries/${scope.entryId}/sharing`;
  }

  private async request(
    path: string,
    method: string,
    body?: object,
  ): Promise<unknown> {
    const keys = this.deps.session.getKeys();
    const apiUrl = this.deps.apiUrl();
    const controller = new AbortController();
    const assertCurrent = () => {
      if (
        !keys ||
        this.deps.session.getKeys() !== keys ||
        this.deps.apiUrl() !== apiUrl ||
        controller.signal.aborted
      )
        throw new WorkspaceError('locked');
    };
    assertCurrent();
    this.pending.add(controller);
    try {
      let token = await this.deps.session.getAccessToken();
      assertCurrent();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!token) throw new WorkspaceError('locked');
        const response = await this.deps.fetch(
          `${apiUrl.replace(/\/$/, '')}${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-Palladin-Vault-Protocol': '2',
              'X-Palladin-Sync-Policy': '2',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
            cache: 'no-store',
            redirect: 'error',
            credentials: 'omit',
          },
        );
        assertCurrent();
        if (response.status === 401 && attempt === 0) {
          await response.body?.cancel();
          token = await this.deps.session.refreshAccessToken();
          assertCurrent();
          continue;
        }
        if (!response.ok)
          throw new WorkspaceError(
            response.status === 403
              ? 'forbidden'
              : response.status === 409
                ? 'conflict'
                : response.status === 401
                  ? 'locked'
                  : 'network',
          );
        const data: unknown =
          response.status === 204 ||
          response.headers.get('content-length') === '0'
            ? null
            : response.headers.get('content-type')?.includes('application/json')
              ? await response.json()
              : null;
        assertCurrent();
        return data;
      }
      throw new WorkspaceError('locked');
    } finally {
      this.pending.delete(controller);
    }
  }
}
