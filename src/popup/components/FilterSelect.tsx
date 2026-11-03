import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { PopupIcon } from './PopupIcon';

interface FilterSelectBase {
  'aria-label': string;
  disabled?: boolean;
  children: ReactNode;
}
type FilterSelectProps = FilterSelectBase & (
  | { multiple: true; value: string[]; onValueChange(value: string[]): void }
  | { multiple?: false; value: string; onValueChange(value: string): void }
);

export function FilterSelect(props: FilterSelectProps) {
  const { children, disabled, 'aria-label': label } = props;
  const selected = (candidate: string) => props.multiple ? (candidate === '' ? props.value.length === 0 : props.value.includes(candidate)) : props.value === candidate;
  function choose(candidate: string) {
    if (props.multiple) props.onValueChange(candidate === '' ? [] : props.value.includes(candidate) ? props.value.filter(item => item !== candidate) : [...props.value, candidate]);
    else { props.onValueChange(candidate); close(); }
  }
  const options = Children.toArray(children).filter(isValidElement<{ value: string; children: ReactNode; disabled?: boolean }>).map(option => option.props);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const expanded = open && !disabled;
  useEffect(() => {
    if (!expanded) return;
    const index = options.findIndex(option => selected(option.value) && !option.disabled);
    choices.current[index < 0 ? 0 : index]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div className="filter-select" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (!expanded && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); }
  }}>
    <button type="button" role="combobox" aria-label={label} aria-expanded={expanded} aria-controls={id} aria-haspopup="listbox" disabled={disabled} ref={trigger} onClick={() => setOpen(current => !current)}>
      <span>{props.multiple && props.value.length > 1 ? `${label} (${props.value.length})` : options.find(option => selected(option.value))?.children}</span><PopupIcon name="chevron" />
    </button>
    {expanded ? <div className="filter-options" id={id} role="listbox" aria-label={label} aria-multiselectable={props.multiple || undefined}>
      {options.map((option, index) => <button type="button" role="option" tabIndex={-1} aria-selected={selected(option.value)} disabled={option.disabled} key={option.value}
        ref={node => { choices.current[index] = node; }} onClick={() => choose(option.value)}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const enabled = choices.current.filter((node): node is HTMLButtonElement => !!node && !node.disabled);
          const current = enabled.indexOf(event.currentTarget);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
          enabled[next]?.focus();
        }}><span>{option.children}</span><PopupIcon name="check" /></button>)}
    </div> : null}
  </div>;
}
