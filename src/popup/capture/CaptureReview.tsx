import { CaptureTransition } from './CaptureTransition';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { EntryIcon, type EntryIconProps } from '../components/EntryIcon';
import { useI18n } from '../i18n';
export type CaptureReviewStage = 'notice' | 'review' | 'saved';
interface Props {
  title: string; savedTitle: string; origin: string; name: string; detail?: string; identity: EntryIconProps;
  stage: CaptureReviewStage; vault?: string; children: ReactNode; saveLabel: string;
  saveForm?: string;
  identityTrailing?: ReactNode;
  onIdentity?(): void;
  busy?: boolean; disabled?: boolean; error?: string;
  onReview(): void; onSave(): void; onDismiss(): void; onDone(): void;
}
export function CaptureReview(props: Props): React.JSX.Element {
  const { t } = useI18n();
  const identityText = <span><strong>{props.name}</strong>{props.detail ? <small>{props.detail}</small> : null}</span>;
  return <CaptureTransition><section className="capture-review" data-stage={props.stage} aria-label={props.title}>
    <div className="capture-review-heading-wrap" aria-hidden={props.stage === 'review'}><div><div className="capture-review-heading"><h3>{props.stage === 'saved' ? props.savedTitle : props.title}</h3><p>{props.stage === 'saved' ? t('captureReview.savedVault', { vault: props.vault ?? '' }) : t('captureReview.source', { origin: props.origin })}</p></div></div></div>
    <div className="entry-identity-card capture-review-identity">{props.onIdentity ? <button type="button" className="capture-review-identity-link" aria-label={props.name} onClick={props.onIdentity}><EntryIcon {...props.identity} /></button> : <EntryIcon {...props.identity} />}{identityText}{props.identityTrailing}</div>
    <div className="capture-review-expansion" inert={props.stage !== 'review'} aria-hidden={props.stage !== 'review'}><div><div className="capture-review-fields">{props.stage !== 'saved' ? props.children : null}</div></div></div>
    {props.error ? <p className="capture-review-error" role="alert">{props.error}</p> : null}
    <div className="capture-review-footer">
      {props.stage !== 'saved' ? <Button variant="subtle" disabled={props.busy} onClick={props.onDismiss}>{t('secretCapture.dismiss')}</Button> : null}
      <Button type={props.stage === 'review' && props.saveForm ? 'submit' : 'button'} form={props.stage === 'review' ? props.saveForm : undefined} loading={!!props.busy} disabled={!!props.busy || props.stage === 'review' && !!props.disabled} onClick={props.stage === 'notice' ? event => { event.preventDefault(); props.onReview(); } : props.stage === 'saved' ? props.onDone : props.saveForm ? undefined : props.onSave}>
        {props.stage === 'notice' ? t('captureReview.review') : props.stage === 'saved' ? t('captureReview.done') : props.saveLabel}
      </Button>
    </div>
  </section></CaptureTransition>;
}
