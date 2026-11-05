import { CaptureTransition } from './CaptureTransition';
import { EntryAutocomplete } from '../components/EntryAutocomplete';
import { cardNetwork } from '@shared/card-network';
import { useEffect, useId, useRef, useState } from 'react';
import { SECRET_CAPTURE_CHANNEL, isSecretCaptureInvalidation, type SecretCapturePopupCommand } from '@shared/messaging/secret-capture';
import type { SecretCaptureResult } from '../../background/capture/secret-coordinator';
import type { ManualEntrySaveInput } from '../../background/vault/protocol2/service';
import { CaptureReview } from './CaptureReview';
import { FilterSelect } from '../components/FilterSelect';
import { ENTRY_TYPE_CREDIT_CARD, ENTRY_TYPE_KEY } from '../../background/vault/entry-metadata';
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
interface SavedSecretSummary {
  name: string; detail: string; vault: string; origin: string; card: boolean;
  entryId?: string; vaultId?: string; icon?: string;
}
export function SecretCaptureSurface({ revision, client, onOpenEntry }: { revision: number; client: VaultClient; onOpenEntry(entryId: string, vaultId: string): void }) {
  const { t } = useI18n();
  const [review, clear] = useSecretCapture(revision);
  const [saved, setSaved] = useState<SavedSecretSummary | null>(null);
  return <CaptureTransition>{saved ? <CaptureReview title={t(saved.card ? 'captureReview.saveCard' : 'captureReview.saveKey')}
    savedTitle={t(saved.card ? 'captureReview.cardSaved' : 'captureReview.keySaved')} stage="saved"
    origin={saved.origin} name={saved.name} detail={saved.detail} vault={saved.vault}
    identity={{ name: saved.name, type: saved.card ? ENTRY_TYPE_CREDIT_CARD : ENTRY_TYPE_KEY, ...(saved.icon ? { icon: saved.icon } : {}) }}
    {...(saved.entryId && saved.vaultId ? { onIdentity: () => { onOpenEntry(saved.entryId!, saved.vaultId!); setSaved(null); } } : {})}
    saveLabel="" onReview={() => {}} onSave={() => {}} onDismiss={() => setSaved(null)} onDone={() => setSaved(null)}>{null}</CaptureReview> : review ? <SecretCapturePrompt key={review.id} review={review} client={client} onDone={clear}
    onSaved={summary => { setSaved(summary); clear(); }} /> : null}</CaptureTransition>;
}
export function SecretCapturePrompt({ review, client, send = sendSecretCapture, onDone, onSaved }: {
  review: Review; client: VaultClient; send?: Send; onDone(): void; onSaved?(summary: SavedSecretSummary): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const formId = useId();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [targetId, setTargetId] = useState('');
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
  const target = selected?.cardTargets?.find(target => target.id === targetId);
  const capturedEntry: ManualEntrySaveInput = draftReview.candidate.kind === 'key'
    ? { entryType: 'key', label: new URL(draftReview.origin).hostname, value: draftReview.candidate.value }
    : { entryType: 'creditCard', label: cardNetwork(draftReview.candidate.cardNumber) ?? t('entry.typeCard'), ...(draftReview.candidate.cvv ? { cvv: draftReview.candidate.cvv } : {}), cardNumber: draftReview.candidate.cardNumber,
      cardholderName: draftReview.candidate.cardholderName, expiryMonth: draftReview.candidate.expiryMonth.padStart(2,'0').replace('00',''),
      expiryYear: draftReview.candidate.expiryYear.length === 2 ? `20${draftReview.candidate.expiryYear}` : draftReview.candidate.expiryYear };
  const initialEntry: ManualEntrySaveInput = target && capturedEntry.entryType === 'creditCard' ? {
    ...target.entry,
    ...(capturedEntry.cardholderName ? { cardholderName: capturedEntry.cardholderName } : {}),
    ...(capturedEntry.expiryMonth ? { expiryMonth: capturedEntry.expiryMonth } : {}),
    ...(capturedEntry.expiryYear ? { expiryYear: capturedEntry.expiryYear } : {}),
    ...(capturedEntry.cvv ? { cvv: capturedEntry.cvv } : {}),
  } : { ...capturedEntry, ...(draftReview.icon ? { icon: draftReview.icon } : {}) };
  async function beginReview() {
    const epoch = ++selectionGeneration.current;
    setSelecting(true); setActionError(false);
    try {
      const result = await send({ channel: SECRET_CAPTURE_CHANNEL, type: 'begin-review', id: review.id });
      if (epoch !== selectionGeneration.current) return;
      if (result.status === 'review' && result.id === review.id) {
        setSelected(result);
        const only = result.cardTargets?.length === 1 ? result.cardTargets[0] : undefined;
        setTargetId(only?.id ?? ''); if (only) setVaultId(only.vaultId);
      }
      else setTerminal('stale');
    } catch { if (epoch === selectionGeneration.current) setActionError(true); }
    finally { if (epoch === selectionGeneration.current) setSelecting(false); }
  }
  async function dismiss(mute = false) {
    try { await send({ channel: SECRET_CAPTURE_CHANNEL, type: mute ? 'mute' : 'dismiss', id: review.id }); onDone(); }
    catch { setActionError(true); }
  }
  if (terminal) return <section className="capture-review"><p role="status">{t(terminal === 'duplicate' ? 'secretCapture.duplicate' : 'secretCapture.expired')}</p><Button onClick={onDone}>{t('captureReview.done')}</Button></section>;
  const card = draftReview.candidate.kind === 'card';
  const name = initialEntry.label;
  const detail = draftReview.candidate.kind === 'card' ? `•••• ${draftReview.candidate.cardNumber.slice(-4)}` : t('entry.typeKey');
  return <CaptureReview title={t(card ? 'captureReview.saveCard' : 'captureReview.saveKey')} savedTitle={t(card ? 'captureReview.cardSaved' : 'captureReview.keySaved')}
    origin={new URL(review.origin).hostname} name={name} detail={detail} identity={{ name, type: card ? ENTRY_TYPE_CREDIT_CARD : ENTRY_TYPE_KEY, ...(initialEntry.icon ? { icon: initialEntry.icon } : {}) }}
    stage={saved ? 'saved' : selected ? 'review' : 'notice'} vault={review.vaults.find(vault => vault.id === vaultId)?.name ?? ''}
    saveLabel={t(target ? 'captureReview.updateCard' : 'entry.save')} saveForm={formId} busy={selecting || saving} disabled={!vaultId || !!selected?.cardTargets?.length && !target}
    {...(actionError ? { error: t('entry.error') } : {})} onIdentity={() => { if (!selected) void beginReview(); else document.getElementById(formId)?.querySelector<HTMLInputElement>('input')?.focus(); }} onReview={() => void beginReview()} onSave={() => {}} onDismiss={() => void dismiss()} onDone={onDone}>
    {selected && !saved ? <>
      {selected.cardTargets?.length ? <EntryAutocomplete label={t('entry.typeCard')} value={targetId} disabled={saving}
        options={selected.cardTargets.map(target => ({ id: target.id, name: target.name, detail: target.vaultName, type: ENTRY_TYPE_CREDIT_CARD }))}
        onValueChange={id => { setTargetId(id); const target = selected.cardTargets?.find(target => target.id === id); if (target) setVaultId(target.vaultId); }} /> : null}
      <label className="field-label">{t('secretCapture.vault')}</label>
      <FilterSelect floating aria-label={t('secretCapture.vault')} value={vaultId} disabled={saving || !!selected.cardTargets?.length} onValueChange={setVaultId}>
        {review.vaults.map(vault => <option value={vault.id} key={vault.id}>{vault.name}</option>)}
      </FilterSelect>
      {vaultId ? <AddEntryForm key={targetId || "create"} client={client} initialEntry={initialEntry} captureFormId={formId} onBusyChange={setSaving} onSave={async entry => {
        if (selected.cardTargets?.length && !target) throw Error('Choose an existing card');
        const epoch = selectionGeneration.current;
        const result = await send(target && entry.entryType === 'creditCard'
          ? { channel: SECRET_CAPTURE_CHANNEL, type: 'update', id: review.id, targetId: target.id, entry }
          : { channel: SECRET_CAPTURE_CHANNEL, type: 'save', id: review.id, vaultId, entry });
        if (epoch !== selectionGeneration.current) throw Error('Capture invalidated');
        if (result.status === 'saved') {
          setSaved(true); setSelected(null);
          onSaved?.({ name: entry.label, detail, card, ...(entry.icon ? { icon: entry.icon } : {}), origin: new URL(review.origin).hostname,
            vault: review.vaults.find(vault => vault.id === vaultId)?.name ?? '',
            ...('entryId' in result && typeof result.entryId === 'string' ? { entryId: result.entryId } : {}),
            ...('vaultId' in result && typeof result.vaultId === 'string' ? { vaultId: result.vaultId } : {}),
          });
          return { status: 'saved' };
        }
        if (result.status === 'duplicate' || result.status === 'stale' || result.status === 'locked') setTerminal(result.status === 'duplicate' ? 'duplicate' : 'stale');
        throw Error('Capture save failed');
      }} /> : <p role="status">{t('secretCapture.unavailable')}</p>}
    </> : null}
  </CaptureReview>;
}
