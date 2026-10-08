import { useI18n } from '../i18n';
import { WorkspaceClientError } from './client';
export function WorkspaceError({ error }: { error: unknown }) {
  const { t } = useI18n();
  const code = error instanceof WorkspaceClientError ? error.code : 'view';
  const status = error instanceof WorkspaceClientError ? error.httpStatus : undefined;
  return <p role="alert" className="workspace-error">{t(code === 'forbidden' ? 'workspace.forbidden' : code === 'locked' ? 'workspace.locked' : 'workspace.error')}{status ? ` [${code}; HTTP ${status}]` : ` [${code}]`}</p>;
}
