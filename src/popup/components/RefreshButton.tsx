import { useI18n } from '../i18n';
import { PopupIcon } from './PopupIcon';

export function RefreshButton({ busy, onClick }: { busy: boolean; onClick(): void }) {
  const { t } = useI18n();
  return <button type="button" className="toolbar-icon refresh-button" disabled={busy}
    aria-label={t('workspace.refresh')} title={t('workspace.refresh')} onClick={onClick}>
    <PopupIcon name="refresh" />
  </button>;
}
