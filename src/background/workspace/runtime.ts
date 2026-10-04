import { vaultData } from '../vault/runtime';
import { webAppUrl } from '../../shared/config/web-app';
import { Protocol2VaultClient } from '../vault/protocol2/client';
import { EntryActions } from './entry-actions';
import { serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { WorkspaceService } from './service';

export const workspaceService = new WorkspaceService({
  session: sessionManager,
  actions: new EntryActions({
    data: vaultData,
    client: new Protocol2VaultClient(
      (...args) => fetch(...args),
      () => serverConfig.apiUrl,
    ),
    session: {
      getPrivateKey: () => sessionManager.getKeys()?.privateKey ?? null,
      getUserId: () => sessionManager.getUserId(),
      getAccessToken: () => sessionManager.getAccessToken(),
      refreshAccessToken: () => sessionManager.refreshAccessToken(),
    },
    webUrl: webAppUrl,
  }),
  apiUrl: () => serverConfig.apiUrl,
  fetch: (...args) => fetch(...args),
});
sessionManager.hooks.onLocked(() => workspaceService.lock());
