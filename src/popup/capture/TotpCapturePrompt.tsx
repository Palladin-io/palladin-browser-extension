import { usePopupView } from '../view/PopupView';
import { useEffect, useRef, useState } from 'react';
import { TOTP_CAPTURE_CHANNEL, type TotpPopupCommand } from '@shared/messaging/totp-capture';
import type { TotpCaptureCoordinator } from '../../background/capture/totp-coordinator';
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
export function TotpCapturePrompt({ review, send = sendDefault, onDone, onSaved }: { review: Review; send?: Send; onDone(): void; onSaved?(): void }) {
  const { t } = useI18n();
  const navigation = usePopupView();
  const [savedTarget, setSavedTarget] = useState<{id:string;vaultId:string} | null>(null);
  const existing = review.targets.filter(target => target.action === 'update');
  const createTargets = review.targets.filter(target => target.action === 'create');
  const [targetId, setTargetId] = useState(existing.length === 1 ? existing[0]!.id : existing.some(target => target.id === review.defaultTargetId) ? review.defaultTargetId! : '');
  const [stage, setStage] = useState<CaptureReviewStage>('notice');
  const [replace, setReplace] = useState(false); const [label, setLabel] = useState(''); const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const target = review.targets.find(item => item.id === targetId);
  async function save() {
    if (!target || busy || target.hasTotp && !replace || target.action === 'create' && !label.trim()) return;
    setBusy(true); setError(false);
    try {
      const result = await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'save', id: review.id, targetId, replace,
        ...(target.action === 'create' ? { create: { label: label.trim(), username } } : {}) });
      if (result.status === 'saved') { if (result.entryId && result.vaultId) setSavedTarget({id:result.entryId,vaultId:result.vaultId}); setLabel(''); setUsername(''); setReplace(false); setStage('saved'); onSaved?.(); } else if (result.status === 'stale') onDone(); else setError(true);
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <CaptureReview title={t('totpCapture.title')} savedTitle={t('captureReview.authenticatorSaved')} origin={new URL(review.origin).hostname}
    name={review.issuer || new URL(review.origin).hostname} {...(review.account ? { detail: review.account } : {})} identity={{ name: review.issuer || '', type: ENTRY_TYPE_CREDENTIAL }}
    stage={stage} {...(target ? { vault: target.vaultLabel } : {})} saveLabel={t('totpCapture.save')} busy={busy}
    disabled={!target || !!target.hasTotp && !replace || target.action === 'create' && !label.trim()}
    {...(error ? { error: t('totpCapture.error') } : {})}
    {...(stage !== 'saved' ? { onIdentity: () => setStage('review') } : savedTarget && navigation ? { onIdentity: () => { navigation.update({view:'vault',selected:savedTarget}); onDone(); } } : {})} onReview={() => setStage('review')} onSave={() => void save()} onDone={onDone}
    onDismiss={() => { setBusy(true); void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'dismiss', id: review.id }).then(onDone).catch(() => { setError(true); setBusy(false); }); }}>
    {existing.length ? <EntryAutocomplete label={t('totpCapture.credential')} value={targetId} disabled={busy}
      options={existing.map(item => ({ id: item.id, name: item.label, detail: item.vaultLabel }))}
      onValueChange={value => { setTargetId(value); setReplace(false); }} /> : target?.action !== 'create' ?
      <Button variant="subtle" disabled={busy || !createTargets.length} onClick={() => { setTargetId(createTargets[0]!.id); setReplace(false); }}>{t('captureReview.createLogin')}</Button> : null}
    {target?.action === 'create' ? <>
      <label className="field-label">{t('secretCapture.vault')}</label><FilterSelect floating aria-label={t('secretCapture.vault')} value={targetId} disabled={busy} onValueChange={setTargetId}>
        {createTargets.map(item => <option value={item.id} key={item.id}>{item.vaultLabel}</option>)}
      </FilterSelect>
      <label>{t('totpCapture.name')}<input className="field-input" value={label} disabled={busy} maxLength={512} onChange={event => setLabel(event.target.value)} /></label>
      <label>{t('totpCapture.username')}<input className="field-input" value={username} disabled={busy} maxLength={512} onChange={event => setUsername(event.target.value)} /></label>
    </> : null}
    {target?.hasTotp ? <label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={replace} onChange={event => setReplace(event.target.checked)} />{t('totpCapture.replace')}</label> : null}
  </CaptureReview>;

}
export function TotpCaptureSurface({ revision }: { revision: number }) {
  const { t } = useI18n(); const [review, setReview] = useState<Review | null>(null); const [empty, setEmpty] = useState(false);
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
    const request = ++sequence.current; setScanning(true); setEmpty(false); setAmbiguous(false);
    try { const result = await sendDefault({ channel: TOTP_CAPTURE_CHANNEL, type: 'scan' });
      if (!mounted.current) return;
      if (request === sequence.current) setReview(result.status === 'ready' ? result : null);
      setAmbiguous(result.status === 'ambiguous'); setEmpty(result.status !== 'ready' && result.status !== 'ambiguous');
    } catch { if (mounted.current) setEmpty(true); } finally { if (mounted.current) setScanning(false); }
  }
  return <>{review ? <TotpCapturePrompt key={review.id} review={review} onSaved={() => { saved.current = true; sequence.current++; }} onDone={() => { saved.current = false; setReview(null); }} /> : null}
    <Button variant="subtle" loading={scanning} disabled={scanning} onClick={() => void scan()}>{t('totpCapture.scan')}</Button>
    {empty ? <p role="status">{t('totpCapture.noResult')}</p> : null}
    {ambiguous ? <p role="status">{t('totpCapture.ambiguous')}</p> : null}</>;
}
