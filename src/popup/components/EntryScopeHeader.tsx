import type { EntryMetadata } from '../../background/vault/entry-metadata';
import { useI18n } from '../i18n';
import { EntryIcon } from './EntryIcon';
import { PopupIcon } from './PopupIcon';

export function EntryScopeHeader({ entry, onBack }: { entry?: EntryMetadata | undefined; onBack?: (() => void) | undefined }) {
  const { t } = useI18n();
  const name = entry?.name ?? t('grant.entry');
  return <div className="entry-scope-header">
    {onBack ? <button type="button" className="toolbar-icon" onClick={onBack} aria-label={t('common.back')} title={t('common.back')}><PopupIcon name="back" /></button> : null}
    {entry ? <EntryIcon name={entry.name} type={entry.type} {...(entry.icon ? { icon: entry.icon } : {})} /> : null}
    <strong title={name}>{name}</strong>
  </div>;
}
