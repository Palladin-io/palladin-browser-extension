import { vaultData } from '../vault/runtime';
import { webAppUrl } from '../../shared/config/web-app';
import { Protocol2VaultClient } from '../vault/protocol2/client';
import { EntryActions } from './entry-actions';
import { serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { WorkspaceError, WorkspaceService } from './service';
import { env } from '../config/env';

export const workspaceService = new WorkspaceService({
  session: sessionManager,
  actions: new EntryActions({
    data: vaultData,
    client: new Protocol2VaultClient(
      (...args) => fetch(...args),
      () => serverConfig.networkApiUrl,
    ),
    session: {
      getPrivateKey: () => sessionManager.getKeys()?.privateKey ?? null,
      getUserId: () => sessionManager.getUserId(),
      getAccessToken: () => sessionManager.getAccessToken(),
      refreshAccessToken: () => sessionManager.refreshAccessToken(),
    },
    webUrl: () => {
      const connection = serverConfig.activeConnection;
      if (connection) return connection.webUrl;
      if (serverConfig.apiUrl !== env.apiUrl) throw new WorkspaceError('invalid');
      return webAppUrl;
    },
  }),
  apiUrl: () => serverConfig.networkApiUrl,
  fetch: (...args) => fetch(...args),
});
sessionManager.hooks.onLocked(() => workspaceService.lock());
