import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ENTRY_COLORS, ENTRY_GLYPHS } from '@shared/entry-icons';
import { ApiUrlContext } from './PublicAssetImages';
import { EntryIcon } from './EntryIcon';
import { EntryGlyph } from './EntryGlyph';
import { useI18n } from '../i18n';
import type { EntryTypeCode } from '../../background/vault/entry-metadata';

interface Presentation { icon?: string; color?: string }
interface Asset { id: string; name: string }
export function EntryIconPicker({ value, onChange, type, disabled }: {
  value: Presentation; onChange(value: Presentation): void; type: EntryTypeCode; disabled: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const apiUrl = useContext(ApiUrlContext);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'symbols' | 'services'>('symbols');
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  useEffect(() => {
    if (!open || tab !== 'services' || !apiUrl) return;
    const controller = new AbortController();
    setLoading(true); setError(false); setAssets([]);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ type: 'websiteIcon', q: query, limit: '40' });
      void fetch(`${apiUrl}/api/public-assets/search?${params}`, {
        signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      }).then(async response => {
        if (!response.ok) throw new Error('Catalog unavailable');
        const page = await response.json() as { items: Asset[] };
        if (!controller.signal.aborted) setAssets(page.items);
      }).catch(() => { if (!controller.signal.aborted) setError(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, tab, apiUrl, query]);
  function close(): void { setOpen(false); trigger.current?.focus(); }
  return <>
    <button ref={trigger} type="button" className="entry-icon-trigger" aria-label={t('icon.choose')} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      <EntryIcon name={t('icon.choose')} type={type} {...value} />
    </button>
    {open ? createPortal(<dialog ref={dialog} className="entry-icon-dialog" aria-label={t('icon.choose')} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="entry-icon-picker">
        <div className="entry-icon-picker-heading"><strong>{t('icon.choose')}</strong><button type="button" className="icon-btn" aria-label={t('icon.close')} onClick={close}>×</button></div>
        <div className="entry-icon-picker-tabs" role="tablist">
          {(['symbols', 'services'] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{t(`icon.${item}`)}</button>)}
        </div>
        {tab === 'symbols' ? <>
          <div className="entry-icon-colors" aria-label={t('icon.color')}>
            <button type="button" aria-label={t('icon.automatic')} aria-pressed={!value.color} onClick={() => onChange(value.icon ? { icon: value.icon } : {})}>↺</button>
            {ENTRY_COLORS.map(color => <button key={color} type="button" style={{ color }} aria-label={`${t('icon.color')} ${color}`} aria-pressed={value.color === color} onClick={() => onChange({ ...value, color })}>●</button>)}
          </div>
          <div className="entry-icon-grid">{ENTRY_GLYPHS.map(icon => <button type="button" key={icon} aria-label={t(`icon.glyph.${icon}`)} title={t(`icon.glyph.${icon}`)} aria-pressed={value.icon === icon} style={value.color ? { color: value.color } : undefined} onClick={() => onChange({ ...value, icon })}><EntryGlyph name={icon} /></button>)}</div>
        </> : <>
          <input className="field-input" aria-label={t('icon.search')} placeholder={t('icon.search')} value={query} maxLength={100} onChange={event => setQuery(event.target.value)} />
          <div className="entry-icon-grid entry-icon-grid--services">{assets.map(asset => <button type="button" key={asset.id} aria-label={asset.name} title={asset.name} aria-pressed={value.icon === `public-asset:${asset.id}`} onClick={() => onChange({ icon: `public-asset:${asset.id}` })}><EntryIcon name={asset.name} type={type} icon={`public-asset:${asset.id}`} /></button>)}</div>
          <p role="status">{error || !apiUrl ? t('icon.error') : loading ? t('icon.loading') : assets.length === 0 ? t('icon.empty') : ''}</p>
        </>}
        <div className="entry-icon-picker-footer"><button type="button" className="link-btn" onClick={() => onChange({})}>{t('icon.automatic')}</button><button type="button" className="btn btn--subtle" onClick={close}>{t('icon.close')}</button></div>
      </div>
    </dialog>, document.body) : null}
  </>;
}
