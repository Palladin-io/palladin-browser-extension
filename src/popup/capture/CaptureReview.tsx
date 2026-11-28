import { CaptureTransition } from './CaptureTransition';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { registrableDomain } from '../../shared/security/domain';
import { Button } from '../components/Button';
import { EntryIcon, type EntryIconProps } from '../components/EntryIcon';
import { useI18n } from '../i18n';
export type CaptureReviewStage = 'notice' | 'review' | 'saved';
interface Props {
  title: string; updated?: boolean; origin: string; name: string; detail?: string; identity: EntryIconProps;
  stage: CaptureReviewStage; vault?: string; children: ReactNode; saveLabel: string;
  saveForm?: string;
  identityTrailing?: ReactNode;
  onIdentity?(): void;
  busy?: boolean; disabled?: boolean; error?: string;
  onMute?(): void;
  menuActions?: readonly { label: string; onSelect(): void }[];
  onReview(): void; onSave(): void; onDismiss(): void; onDone(): void;
}
export function CaptureReview(props: Props): React.JSX.Element {
  const { t } = useI18n();
  const footerSaved = props.stage === 'saved';
  const [menuOpen, setMenuOpen] = useState(false);
  const split = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const savedMenu = props.stage === 'saved' && !!props.onIdentity;
  const menuVisible = menuOpen && !props.busy && (props.stage !== 'saved' || savedMenu);
  useEffect(() => {
    if (!menuVisible) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !split.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); toggle.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuVisible]);
  const detail = props.stage === 'saved' ? [props.vault, props.detail].filter(Boolean).join(' · ') : props.detail;
  const identityText = <span><strong>{props.name}</strong>{detail ? <small>{detail}</small> : null}</span>;
  const optionsToggle = <button type="button" className="btn btn--subtle capture-dismiss-options" ref={toggle} disabled={props.busy}
    aria-label={t(footerSaved ? 'captureReview.savedOptions' : 'captureToast.dismissOptions')} aria-haspopup="menu" aria-expanded={menuVisible}
    onClick={() => setMenuOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true); }
    }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>;
  return <CaptureTransition><section className="capture-review" data-stage={props.stage} aria-label={props.title}>
    {props.stage !== 'saved' ? <div className="capture-review-heading-wrap" aria-hidden={props.stage === 'review'}><div><div className="capture-review-heading"><h3>{props.title}</h3><p>{t('captureReview.source', { origin: props.origin })}</p></div></div></div> : null}
    <div className="entry-identity-card capture-review-identity">{props.onIdentity ? <button type="button" className="capture-review-identity-link" aria-label={props.name} onClick={props.onIdentity}><EntryIcon {...props.identity} /></button> : <EntryIcon {...props.identity} />}{identityText}{props.identityTrailing}</div>
    <div className="capture-review-expansion" inert={props.stage !== 'review'} aria-hidden={props.stage !== 'review'}><div><div className="capture-review-fields">{props.stage !== 'saved' ? props.children : null}</div></div></div>
    {props.error ? <p className="capture-review-error" role="alert">{props.error}</p> : null}
    <div className="capture-review-footer-space"><div className="capture-review-footer" data-saved={footerSaved}>
      {footerSaved ? <div className="capture-dismiss-split" ref={split}>
        <div className="capture-saved-status" role="status">{t(props.updated ? 'captureReview.statusUpdated' : 'captureReview.statusSaved')}</div>
        {savedMenu ? optionsToggle : null}
        {menuVisible ? <div className="capture-site-preference" role="menu">
          <button type="button" role="menuitem" autoFocus onClick={() => { setMenuOpen(false); props.onIdentity?.(); }}>{t('captureReview.goToEntry')}</button>
        </div> : null}
      </div> : <div className="capture-dismiss-split" ref={split}>
        <Button variant="subtle" disabled={props.busy} onClick={() => { setMenuOpen(false); props.onDismiss(); }}>{t('secretCapture.dismiss')}</Button>
        {props.onMute ? optionsToggle : null}
        {menuVisible && props.onMute ? <div className="capture-site-preference" role="menu">
          {(props.menuActions ?? []).map((action, index) => <button key={action.label} type="button" role="menuitem" autoFocus={index === 0}
            onClick={() => { setMenuOpen(false); action.onSelect(); }}>{action.label}</button>)}
          <button type="button" role="menuitem" autoFocus={!props.menuActions?.length} onClick={() => { setMenuOpen(false); props.onMute?.(); }}>
            {t('captureToast.mute')}<small>{registrableDomain(props.origin) ?? props.origin}</small>
          </button>
        </div> : null}
      </div>}
      <Button type={props.stage === 'review' && props.saveForm ? 'submit' : 'button'} form={props.stage === 'review' ? props.saveForm : undefined} loading={!!props.busy} disabled={!!props.busy || props.stage === 'review' && !!props.disabled} onClick={props.stage === 'notice' ? event => { event.preventDefault(); props.onReview(); } : props.stage === 'saved' ? props.onDone : props.saveForm ? undefined : props.onSave}>
        {props.stage === 'notice' ? t('captureReview.review') : props.stage === 'saved' ? t('captureReview.done') : props.saveLabel}
      </Button>
    </div></div>
  </section></CaptureTransition>;
}
