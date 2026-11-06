import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { EntryIcon } from './EntryIcon';
import { PopupIcon } from './PopupIcon';
import { ENTRY_TYPE_CREDENTIAL, type EntryTypeCode } from '../../background/vault/entry-metadata';
import { useI18n } from '../i18n';

export interface EntryAutocompleteOption { id: string; name: string; detail?: string; icon?: string; color?: string; type?: EntryTypeCode; account?: string; hasTotp?: boolean }
export interface EntryAutocompleteProps { label: string; options: readonly EntryAutocompleteOption[]; value: string; onValueChange(value: string): void; disabled?: boolean; placeholder?: string }

export function EntryAutocomplete({ label, options, value, onValueChange, disabled, placeholder }: EntryAutocompleteProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [limit, setLimit] = useState(5);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({ left: 0, top: 0, width: 0, maxHeight: 250 });
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = options.find(option => option.id === value);
  const matches = options.filter(option => `${option.name} ${option.account ?? ''} ${option.detail ?? ''}`.toLocaleLowerCase().includes((query ?? '').toLocaleLowerCase()));
  const visible = matches.slice(0, limit);
  const expanded = open && !disabled;
  function close() { setOpen(false); setQuery(null); setActive(-1); }
  function show() { if (disabled) return; setOpen(true); setLimit(5); setActive(-1); }
  function choose(option: EntryAutocompleteOption) { onValueChange(option.id); close(); input.current?.focus(); }
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    const positionMenu = () => {
      const rect = root.current?.getBoundingClientRect(); if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = below < 150 && rect.top > below;
      const maxHeight = Math.min(250, Math.max(80, above ? rect.top - 8 : below));
      setPosition({ left: rect.left, width: rect.width, ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }), maxHeight });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !menu.current?.contains(event.target)) close();
    };
    positionMenu();
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', positionMenu); window.addEventListener('scroll', positionMenu, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', positionMenu); window.removeEventListener('scroll', positionMenu, true); };
  }, [expanded]);
  useEffect(() => { if (expanded && active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' }); }, [expanded, active, limit, id]);
  return <div className="entry-autocomplete">
    <label className="field-label" htmlFor={`${id}-input`}>{label}</label>
    <div className="entry-autocomplete-control" ref={root}>
      <input id={`${id}-input`} ref={input} role="combobox" className="field-input" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded && visible[active] ? `${id}-${active}` : undefined} autoComplete="off" disabled={disabled}
        value={query ?? selected?.name ?? ''} placeholder={placeholder ?? t('captureReview.chooseEntry')}
        onClick={() => { if (!expanded) show(); }} onFocus={show}
        onBlur={event => { if (!root.current?.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) close(); }}
        onChange={event => { setQuery(event.target.value); setLimit(5); setActive(-1); setOpen(true); onValueChange(''); }}
        onKeyDown={event => {
          if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); if (!expanded) { show(); return; }
            const next = Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
            if (next >= limit) setLimit(current => current + 5);
            setActive(next);
          }
          if (event.key === 'Enter' && expanded) { event.preventDefault(); const option = visible[active < 0 ? 0 : active]; if (option) choose(option); }
        }} />
      <button type="button" tabIndex={-1} aria-label={t('captureReview.chooseEntry')} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => expanded ? close() : show()}><PopupIcon name="chevron" /></button>
    </div>
    {selected?.detail ? <small className="capture-field-hint">{selected.account ? `${selected.account} · ` : ''}{selected.detail}</small> : null}
    {expanded ? createPortal(<div ref={menu} className="entry-autocomplete-menu" style={position} id={id} role="listbox" aria-label={label}
      onMouseDown={event => event.preventDefault()} onScroll={event => {
        const list = event.currentTarget;
        if (list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 8) setLimit(current => Math.min(matches.length, current + 5));
      }}>
      {visible.map((option, index) => <button key={option.id} id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={option.id === value}
        className={`entry-head${index === active ? ' entry-autocomplete-active' : ''}`} onClick={() => choose(option)}>
        <EntryIcon name={option.name} type={option.type ?? ENTRY_TYPE_CREDENTIAL} {...(option.icon ? { icon: option.icon } : {})} {...(option.color ? { color: option.color } : {})} />
        <span className="entry-text"><span className="entry-name">{option.account || option.name}</span>{option.detail || option.account ? <span className="entry-sub">{option.account ? `${option.name} · ${option.detail ?? ''}` : option.detail}</span> : null}</span>
        {option.hasTotp ? <span className="capture-totp-badge" aria-label={t('captureReview.totpSavedBadge')} title={t('captureReview.totpSavedBadge')}><PopupIcon name="lock" /></span> : null}
      </button>)}
      {matches.length === 0 ? <p role="status">{t('captureReview.noEntries')}</p> : null}
    </div>, document.body) : null}
  </div>;
}
