import { useI18n } from '../i18n';
import { ListSkeleton } from './ListSkeleton';
export function LoadingSkeleton() {
  const { t } = useI18n();
  return <div className="loading-skeleton" role="status" aria-label={t('workspace.loading')}><ListSkeleton /></div>;
}
