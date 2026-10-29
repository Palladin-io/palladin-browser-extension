import { useEffect, useRef, useState } from 'react';
import { SECRET_CAPTURE_CHANNEL, isSecretCaptureInvalidation, type SecretCapturePopupCommand } from '@shared/messaging/secret-capture';
import type { SecretCaptureResult } from '../../background/capture/secret-coordinator';
import type { ManualEntrySaveInput } from '../../background/vault/protocol2/service';
import { AddEntryForm } from '../entries/AddEntryForm';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';
import type { VaultClient } from '../vault/client';

type Review = Extract<SecretCaptureResult, { status: 'review' }>;
type Send = (command: SecretCapturePopupCommand) => Promise<SecretCaptureResult>;
export const sendSecretCapture: Send = command => chrome.runtime.sendMessage(command);
export function useSecretCapture(revision: number): [Review | null, () => void] {
  const [review, setReview] = useState<Review | null>(null);
  useEffect(() => {
    let mounted = true, generation = 0;
    const refresh = async () => {
      const epoch = ++generation;
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
        const result = await sendSecretCapture({ channel: SECRET_CAPTURE_CHANNEL, type: 'get' });
        if (mounted && epoch === generation) setReview(result?.status === 'review' ? result : null);
      } catch { if (mounted && epoch === generation) setReview(null); }
    };
    const changed = (raw: unknown) => {
      if (raw && typeof raw === 'object' && 'type' in raw) {
        if (isSecretCaptureInvalidation(raw)) {
          generation++;
          setReview(current => current && raw.candidateIds && !raw.candidateIds.includes(current.id) ? current : null);
        }
        if (raw.type === 'secret-capture/available') void refresh();
      }
    };
    void refresh();
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    runtime?.onMessage?.addListener(changed);
    // Fixed worker expiry also drops an already-open editor's plaintext draft.
    const timer = setInterval(() => void refresh(), 5_000);
    return () => { mounted = false; generation++; clearInterval(timer); runtime?.onMessage?.removeListener(changed); };
  }, [revision]);
  return [review, () => setReview(null)];
}
export function SecretCapturePrompt({ review, client, send = sendSecretCapture, onDone }: {
  review: Review; client: VaultClient; send?: Send; onDone(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Review | null>(null);
  const [selecting, setSelecting] = useState(false);
  const draftReview = selected ?? review;
  const [vaultId, setVaultId] = useState(review.vaults.find(v => v.isDefault)?.id ?? review.vaults[0]?.id ?? '');
  const [terminal, setTerminal] = useState<'stale' | 'duplicate' | null>(null);
  const [actionError, setActionError] = useState(false);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    const changed = (raw: unknown) => {
      if (!isSecretCaptureInvalidation(raw) || raw.candidateIds && !raw.candidateIds.includes(review.id)) return;
      selectionGeneration.current++; setSelecting(false);
      setSelected(null); setTerminal('stale');
    };
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    runtime?.onMessage?.addListener(changed);
    return () => { selectionGeneration.current++; runtime?.onMessage?.removeListener(changed); };
  }, [review.id]);
  const initialEntry: ManualEntrySaveInput = draftReview.candidate.kind === 'key'
    ? { entryType: 'key', label: new URL(draftReview.origin).hostname, value: draftReview.candidate.value }
    : { entryType: 'creditCard', label: new URL(draftReview.origin).hostname, cardNumber: draftReview.candidate.cardNumber,
      cardholderName: draftReview.candidate.cardholderName, expiryMonth: draftReview.candidate.expiryMonth.padStart(2,'0').replace('00',''),
      expiryYear: draftReview.candidate.expiryYear.length === 2 ? `20${draftReview.candidate.expiryYear}` : draftReview.candidate.expiryYear };
  async function beginReview() {
    const epoch = ++selectionGeneration.current;
    setSelecting(true); setActionError(false);
    try {
      const result = await send({ channel: SECRET_CAPTURE_CHANNEL, type: 'begin-review', id: review.id });
      if (epoch !== selectionGeneration.current) return;
      if (result.status === 'review' && result.id === review.id) setSelected(result);
      else setTerminal('stale');
    } catch { if (epoch === selectionGeneration.current) setActionError(true); }
    finally { if (epoch === selectionGeneration.current) setSelecting(false); }
  }
  async function dismiss(mute = false) {
    try { await send({ channel: SECRET_CAPTURE_CHANNEL, type: mute ? 'mute' : 'dismiss', id: review.id }); onDone(); }
    catch { setActionError(true); }
  }
  return <section className="capture-prompt" aria-label={t('secretCapture.title')}>
    <h3>{t('secretCapture.title')}</h3>
    <p>{review.origin}</p>
    {terminal ? <p role="status">{t(terminal === 'duplicate' ? 'secretCapture.duplicate' : 'secretCapture.expired')}</p> : selected ? <>
      <label><span className="field-label">{t('secretCapture.vault')}</span>
        <select className="field-input" value={vaultId} onChange={event => setVaultId(event.target.value)}>
          {review.vaults.map(vault => <option value={vault.id} key={vault.id}>{vault.isDefault ? `${vault.name} - ${t('secretCapture.personal')}` : vault.name}</option>)}
        </select>
      </label>
      {vaultId ? <AddEntryForm client={client} initialEntry={initialEntry} onSave={async entry => {
        const result = await send({ channel: SECRET_CAPTURE_CHANNEL, type: 'save', id: review.id, vaultId, entry });
        if (result.status === 'saved') { onDone(); return { status: 'saved' }; }
        if (result.status === 'duplicate' || result.status === 'stale' || result.status === 'locked') setTerminal(result.status === 'duplicate' ? 'duplicate' : 'stale');
        throw Error('Capture save failed');
      }} /> : <p role="status">{t('secretCapture.unavailable')}</p>}
    </> : <Button loading={selecting} disabled={selecting} onClick={() => void beginReview()}>{t('secretCapture.review')}</Button>}
    <Button variant="subtle" onClick={() => void dismiss()}>{t('secretCapture.dismiss')}</Button>
    {!terminal ? <Button variant="subtle" onClick={() => void dismiss(true)}>{t('secretCapture.mute')}</Button> : null}
    {actionError ? <p role="alert">{t('entry.error')}</p> : null}
  </section>;
}
