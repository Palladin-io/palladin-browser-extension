import { useEffect, useRef, useState } from 'react';
import { TOTP_CAPTURE_CHANNEL, type TotpPopupCommand } from '@shared/messaging/totp-capture';
import type { TotpCaptureCoordinator } from '../../background/capture/totp-coordinator';
import { PopupIcon } from '../components/PopupIcon';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';

type Review = Extract<Awaited<ReturnType<TotpCaptureCoordinator['review']>>, { status: 'ready' }>;
type Result = Awaited<ReturnType<TotpCaptureCoordinator['review']>> | { status: 'saved' | 'stale' | 'error' | 'invalid' | 'dismissed' | 'confirmation-required' | 'ambiguous' };
type Send = (command: TotpPopupCommand) => Promise<Result>;
const sendDefault: Send = command => chrome.runtime.sendMessage(command);
export function TotpCapturePrompt({ review, send = sendDefault, onDone }: { review: Review; send?: Send; onDone(): void }) {
  const { t } = useI18n();
  const [targetId, setTargetId] = useState(review.defaultTargetId ?? '');
  const [replace, setReplace] = useState(false); const [label, setLabel] = useState(''); const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const target = review.targets.find(item => item.id === targetId);
  async function save() {
    if (!target || busy || target.hasTotp && !replace || target.action === 'create' && !label.trim()) return;
    setBusy(true); setError(false);
    try {
      const result = await send({ channel: TOTP_CAPTURE_CHANNEL, type: 'save', id: review.id, targetId, replace,
        ...(target.action === 'create' ? { create: { label: label.trim(), username } } : {}) });
      if (result.status === 'saved' || result.status === 'stale') onDone(); else setError(true);
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <section className="capture-prompt" aria-label={t('totpCapture.title')}>
    <h3>{t('totpCapture.title')}</h3><p>{t('totpCapture.source', { origin: review.origin })}</p>
    {review.issuer || review.account ? <p>{[review.issuer, review.account].filter(Boolean).join(' - ')}</p> : null}
    <label><span className="field-label">{t('totpCapture.credential')}</span>
      <select className="field-input" aria-label={t('totpCapture.credential')} value={targetId} onChange={event => { setTargetId(event.target.value); setReplace(false); }}>
        <option value="">{t('totpCapture.choose')}</option>
        {review.targets.map(item => <option key={item.id} value={item.id}>{item.action === 'create' ? `${t('totpCapture.create')} - ${item.vaultLabel}` : `${item.label} - ${item.vaultLabel}`}</option>)}
      </select>
    </label>
    {target?.action === 'create' ? <><label>{t('totpCapture.name')}<input className="field-input" value={label} maxLength={512} onChange={event => setLabel(event.target.value)} /></label>
      <label>{t('totpCapture.username')}<input className="field-input" value={username} maxLength={512} onChange={event => setUsername(event.target.value)} /></label></> : null}
    {target?.hasTotp ? <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />{t('totpCapture.replace')}</label> : null}
    {error ? <p role="alert">{t('totpCapture.error')}</p> : null}
    <Button disabled={!target || busy || target.action === 'create' && !label.trim()} loading={busy} onClick={() => void save()}>{t('totpCapture.save')}</Button>
    <Button variant="subtle" disabled={busy} onClick={() => { void send({ channel: TOTP_CAPTURE_CHANNEL, type: 'dismiss', id: review.id }).finally(onDone); }}>{t('totpCapture.cancel')}</Button>
  </section>;
}
export function TotpCaptureSurface({ revision, entry }: { revision: number; entry?: { id: string; vaultId: string } }) {
  const { t } = useI18n(); const [review, setReview] = useState<Review | null>(null); const [empty, setEmpty] = useState(false);
  const [scanning, setScanning] = useState(false); const [ambiguous, setAmbiguous] = useState(false);
  const sequence = useRef(0); const mounted = useRef(true);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage || !chrome.runtime.onMessage) return;
    let active = true; mounted.current = true;
    const runtime = chrome.runtime;
    const load = () => { const request = ++sequence.current; void sendDefault({ channel: TOTP_CAPTURE_CHANNEL, type: 'get' }).then(result => {
      if (active && request === sequence.current) setReview(result.status === 'ready' ? result : null);
    }).catch(() => { if (active && request === sequence.current) setReview(null); }); };
    load();
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'totp-capture/available') load();
      if (message.type === 'totp-capture/invalidated') { sequence.current++; setReview(null); }
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
  return <>{scopedReview ? <TotpCapturePrompt key={scopedReview.id} review={scopedReview} onDone={() => setReview(null)} /> : null}
    {entry ? <button className="detail-link" disabled={scanning} onClick={() => void scan()}><PopupIcon name="qr" />{t('totpCapture.scan')}<PopupIcon name="chevron" /></button> : null}
    {entry && visibleReview && !scopedReview ? <p role="status">{t('totpCapture.entryUnavailable')}</p> : null}
    {empty ? <p role="status">{t('totpCapture.noResult')}</p> : null}
    {ambiguous ? <p role="status">{t('totpCapture.ambiguous')}</p> : null}</>;
}
