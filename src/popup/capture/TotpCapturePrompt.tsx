import type { CaptureDraft } from '../../shared/messaging/capture-draft';
import { usePopupView } from '../view/PopupView';
import { useEffect, useRef, useState } from 'react';
import { TOTP_CAPTURE_CHANNEL, type TotpPopupCommand } from '@shared/messaging/totp-capture';
import type { TotpCaptureCoordinator } from '../../background/capture/totp-coordinator';
import { PopupIcon } from '../components/PopupIcon';
import { Button } from '../components/Button';
import { EntryAutocomplete } from '../components/EntryAutocomplete';
import { FilterSelect } from '../components/FilterSelect';
import { CaptureReview, type CaptureReviewStage } from './CaptureReview';
import { ENTRY_TYPE_CREDENTIAL } from '../../background/vault/entry-metadata';
import { useI18n } from '../i18n';

type Review = Extract<Awaited<ReturnType<TotpCaptureCoordinator['review']>>, { status: 'ready' }>;
type Result = Awaited<ReturnType<TotpCaptureCoordinator['review']>> | Awaited<ReturnType<TotpCaptureCoordinator['save']>> | { status: 'stale' | 'error' | 'invalid' | 'dismissed' | 'confirmation-required' | 'ambiguous' };
type Send = (command: TotpPopupCommand) => Promise<Result>;
const sendDefault: Send = command => chrome.runtime.sendMessage(command);
export function TotpCapturePrompt({ review, send = sendDefault, onDone, onSaved, onOpenCapture, initialDraft, initialExpanded = false }: { initialDraft?: Extract<CaptureDraft,{kind:'totp'}> | undefined; onOpenCapture?(saved: boolean, draft?: CaptureDraft): void; initialExpanded?: boolean; review: Review; send?: Send; onDone(): void; onSaved?(): void }) {
  const { t } = useI18n();
  const navigation = usePopupView();
  const [savedTarget, setSavedTarget] = useState<{id:string;vaultId:string} | null>(null);
  const [savedIdentity,setSavedIdentity]=useState<{name:string;account:string}|null>(null);
  const existing = review.targets.filter(target => target.action === 'update');
  const createTargets = review.targets.filter(target => target.action === 'create');
  const [targetId, setTargetId] = useState(initialDraft?.targetId ?? (existing.length === 1 ? existing[0]!.id : existing.some(target => target.id === review.defaultTargetId) ? review.defaultTargetId! : ''));
  const [stage, setStage] = useState<CaptureReviewStage>(initialExpanded ? 'review' : 'notice');
  const [replace, setReplace] = useState(initialDraft?.replace ?? false); const [label, setLabel] = useState(initialDraft?.label ?? new URL(review.origin).hostname); const [username, setUsername] = useState(initialDraft?.username ?? review.account ?? '');
  const [confirmDomainMismatch, setConfirmDomainMismatch] = useState(initialDraft?.confirmDomainMismatch ?? false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const manual = Boolean(review.entryScope);
  const target = review.targets.find(item => manual
    ? item.entryId === review.entryScope?.id && item.vaultId === review.entryScope.vaultId && item.action === 'update'
    : item.id === targetId);
  async function save() {
    if (!target || busy || !manual && (target.domainMismatch && !confirmDomainMismatch || target.hasTotp && !replace) || target.action === 'create' && !label.trim()) return;
    setBusy(true); setError(false);
    try {
      const result = await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'save', id: review.id, targetId: target.id, replace: manual ? target.hasTotp : replace, confirmDomainMismatch: manual ? target.domainMismatch : confirmDomainMismatch,
        ...(target.action === 'create' ? { create: { label: label.trim(), username } } : {}) });
      if (result.status === 'saved') { if (manual) { onDone(); return; } if (result.entryId && result.vaultId) setSavedTarget({id:result.entryId,vaultId:result.vaultId}); setSavedIdentity({name:target.action==='create'?label.trim():target.name??target.label,account:target.action==='create'?username:target.username??review.account??''}); setLabel(''); setUsername(''); setReplace(false); setStage('saved'); onSaved?.(); } else if (result.status === 'stale') onDone(); else setError(true);
    } catch { setError(true); } finally { setBusy(false); }
  }
  if (manual) return <section className="capture-prompt" aria-label={t('totpCapture.title')}>
    <div className="totp-domain-warning" role={target?.domainMismatch || target?.hasTotp ? 'alert' : 'status'}>
      <h3>{target?.domainMismatch || target?.hasTotp ? <><span className="totp-warning-label">{t('totpCapture.warning')}</span><span className="totp-warning-separator" aria-hidden="true">|</span></> : null}<span>{t('totpCapture.title')}</span></h3>
      <p>{t(target?.domainMismatch ? 'totpCapture.entryDomainWarning' : 'totpCapture.confirmSave')}
        {target?.hasTotp ? ` ${t('totpCapture.replaceNotice')}` : null}</p>
    </div>
    {error ? <p role="alert">{t('totpCapture.error')}</p> : null}
    <div className="totp-scan-actions">
      <Button variant="subtle" disabled={busy} onClick={() => { setBusy(true); void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'dismiss', id: review.id }).then(onDone).catch(() => { setError(true); setBusy(false); }); }}>{t('totpCapture.cancel')}</Button>
      <Button disabled={!target || busy} loading={busy} onClick={() => void save()}>{t(target?.hasTotp ? 'totpCapture.replaceAction' : 'common.save')}</Button>
    </div>
  </section>;
  return <CaptureReview title={t('totpCapture.title')} savedTitle={t('captureReview.authenticatorSaved')} origin={new URL(review.origin).hostname}
    name={savedIdentity?.name ?? new URL(review.origin).hostname} {...((savedIdentity?.account ?? review.account) ? { detail: t('captureReview.totpIdentity',{account:savedIdentity?.account ?? review.account!}) } : {})} identity={{ name: new URL(review.origin).hostname, type: ENTRY_TYPE_CREDENTIAL, ...(review.icon ? {icon:review.icon} : {}) }}
    stage={stage} {...(target ? { vault: target.vaultLabel } : {})} saveLabel={t('totpCapture.save')} busy={busy}
    disabled={!target || !!target.domainMismatch && !confirmDomainMismatch || !!target.hasTotp && !replace || target.action === 'create' && !label.trim()}
    {...(error ? { error: t('totpCapture.error') } : {})}
    {...(onOpenCapture ? {onIdentity: () => onOpenCapture(stage === 'saved',{kind:'totp',targetId,label,username,replace,confirmDomainMismatch})} : stage === 'saved' && savedTarget && navigation ? { onIdentity: () => { navigation.update({view:'vault',selected:savedTarget}); onDone(); } } : {})} onReview={() => setStage('review')} onSave={() => void save()} onDone={onDone}
    onDismiss={() => { setBusy(true); void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'dismiss', id: review.id }).then(onDone).catch(() => { setError(true); setBusy(false); }); }}>
    {existing.length ? <EntryAutocomplete label={t('totpCapture.credential')} value={targetId} disabled={busy}
      options={existing.map(item => ({ id: item.id, name: item.name ?? item.label, detail: item.vaultLabel, hasTotp:item.hasTotp, ...(item.username ? {account:item.username} : {}), ...(item.icon ? {icon:item.icon} : {}) }))}
      onValueChange={value => { setTargetId(value); setReplace(false); setConfirmDomainMismatch(false); }} /> : target?.action !== 'create' ?
      <Button variant="subtle" disabled={busy || !createTargets.length} onClick={() => { setTargetId((createTargets.find(item => item.isDefault) ?? createTargets[0])!.id); setReplace(false); setConfirmDomainMismatch(false); }}>{t('captureReview.createLogin')}</Button> : null}
    {target?.action === 'create' ? <>
      <label className="field-label">{t('captureReview.vault')}</label><FilterSelect floating aria-label={t('captureReview.vault')} value={targetId} disabled={busy} onValueChange={value => { setTargetId(value); setReplace(false); setConfirmDomainMismatch(false); }}>
        {createTargets.map(item => <option value={item.id} key={item.id}>{item.vaultLabel}</option>)}
      </FilterSelect>
      <label><span className="field-label">{t('totpCapture.name')}</span><input className="field-input" autoComplete="off" value={label} disabled={busy} maxLength={512} onChange={event => setLabel(event.target.value)} /></label>
      <label><span className="field-label">{t('totpCapture.username')}</span><input className="field-input" autoComplete="off" value={username} disabled={busy} maxLength={512} onChange={event => setUsername(event.target.value)} /></label>
    </> : null}
    {target?.domainMismatch ? <div>
      <p className="capture-warning">{t('totpCapture.domainWarning')}</p>
      <label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={confirmDomainMismatch} onChange={event => setConfirmDomainMismatch(event.target.checked)} />{t('totpCapture.confirmDomain')}</label>
    </div> : null}
    {target?.hasTotp ? <label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={replace} onChange={event => setReplace(event.target.checked)} />{t('captureReview.totpReplaceFor',{name:target.label})}</label> : null}
    <p className="capture-field-hint">{t(!target ? 'captureReview.totpChooseHint' : target.action === 'create' ? 'captureReview.totpNewHint' : target.hasTotp ? 'captureReview.totpReplaceHint' : 'captureReview.totpAddedHint')}</p>
  </CaptureReview>;

}
export function TotpCaptureSurface({ revision, entry }: { revision: number; entry?: { id: string; vaultId: string } }) {
  const { t } = useI18n(); const [review, setReview] = useState<Review | null>(null); const [empty, setEmpty] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scanning, setScanning] = useState(false); const [ambiguous, setAmbiguous] = useState(false);
  const saved = useRef(false);
  const sequence = useRef(0); const mounted = useRef(true);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage || !chrome.runtime.onMessage) return;
    let active = true; mounted.current = true;
    const runtime = chrome.runtime;
    const load = () => { const request = ++sequence.current; void sendDefault({ channel: TOTP_CAPTURE_CHANNEL, type: 'get' }).then(result => {
      if (active && request === sequence.current && !saved.current) setReview(result.status === 'ready' ? result : null);
    }).catch(() => { if (active && request === sequence.current && !saved.current) setReview(null); }); };
    load();
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'totp-capture/available') load();
      if (message.type === 'totp-capture/invalidated') { sequence.current++; saved.current = false; setReview(null); }
    };
    runtime.onMessage.addListener(listener);
    return () => { active = false; mounted.current = false; sequence.current++; runtime.onMessage.removeListener(listener); };
  }, [revision]);
  async function scan() {
    if (!entry) return;
    const request = ++sequence.current; setScanning(true); setEmpty(false); setAmbiguous(false);
    try { const result = await sendDefault({ channel: TOTP_CAPTURE_CHANNEL, type: 'scan', entry: { id: entry.id, vaultId: entry.vaultId } });
      if (!mounted.current) return;
      if (request === sequence.current) setReview(result.status === 'ready' ? result : null);
      setAmbiguous(result.status === 'ambiguous'); setEmpty(result.status !== 'ready' && result.status !== 'ambiguous');
    } catch { if (mounted.current) setEmpty(true); } finally { if (mounted.current) setScanning(false); }
  }
  const visibleReview = review && (entry
    ? review.entryScope?.id === entry.id && review.entryScope.vaultId === entry.vaultId
    : !review.entryScope) ? review : null;
  const scopedReview = visibleReview?.targets.length ? visibleReview : null;
  const content = <>
    {scopedReview ? <TotpCapturePrompt key={scopedReview.id} review={scopedReview} onSaved={() => { saved.current = true; sequence.current++; }} onDone={() => { saved.current = false; setReview(null); setExpanded(false); }} /> : null}
    {entry && visibleReview && !scopedReview ? <p className="entry-status totp-capture-feedback" role="status">{t('totpCapture.entryUnavailable')}</p> : null}
    {empty ? <p className="entry-status totp-capture-feedback" role="status">{t('totpCapture.noResult')}</p> : null}
    {ambiguous ? <p className="entry-status totp-capture-feedback" role="status">{t('totpCapture.ambiguous')}</p> : null}
  </>;
  if (!entry) return content;
  return <>
    <button className="detail-link totp-scan-toggle" aria-expanded={expanded} disabled={scanning} onClick={() => {
      if (expanded) setExpanded(false);
      else { setExpanded(true); void scan(); }
    }}><PopupIcon name="qr" />{t('totpCapture.scan')}<PopupIcon name="chevron" /></button>
    {expanded ? <div className="totp-scan-content">{content}</div> : null}
  </>;
}
