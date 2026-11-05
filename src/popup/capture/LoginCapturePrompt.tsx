import { useEffect, useRef, useState } from 'react';
import { ENTRY_TYPE_CREDENTIAL } from '../../background/vault/entry-metadata';
import { NATIVE_LOGIN_CAPTURE_CHANNEL, type NativeLoginCaptureCommand, type NativeLoginCaptureResult, type NativeLoginCaptureReview } from '../../shared/messaging/native-login-capture';
import { SIGN_IN_PROVIDER_NAMES } from '../../shared/signin/providers';
import { sameSignInAccount } from '../../shared/signin/binding';
import { EntryAutocomplete } from '../components/EntryAutocomplete';
import { EntryIcon } from '../components/EntryIcon';
import { Button } from '../components/Button';
import { AddEntryForm } from '../entries/AddEntryForm';
import { useI18n } from '../i18n';
import { usePopupView } from '../view/PopupView';
import { createVaultClient } from '../vault/client';
import { CaptureReview, type CaptureReviewStage } from './CaptureReview';

type Send = (command: NativeLoginCaptureCommand) => Promise<NativeLoginCaptureResult>;
const sendNative: Send = async command => chrome.runtime.sendMessage(command);
const vaultClient = createVaultClient();
function safeSummary(review: NativeLoginCaptureReview): NativeLoginCaptureReview {
  return review.kind === 'credential' ? { ...review, entry: { entryType: 'credential', label: review.entry.label,
    username: '', password: '', url: review.entry.url ?? '' } } : { ...review, prompt: { ...review.prompt, accounts: [] } };
}
export function LoginCaptureSurface({ revision }: { revision: number }): React.JSX.Element | null {
  const [review, setReview] = useState<NativeLoginCaptureReview | null>(null);
  const saved = useRef(false), saving = useRef(false), generation = useRef(0);
  const sourceTabId = useRef<number | null>(null), promptId = useRef<string | null>(null);
  useEffect(() => {
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    let current = true;
    const invalidate = () => { generation.current++; if (!saved.current) { promptId.current = null; setReview(null); } };
    const listener = (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'login-capture/invalidated'
        && (!('tabId' in message) || sourceTabId.current === null || message.tabId === sourceTabId.current)) invalidate();
    };
    runtime?.onMessage?.addListener(listener);
    const timer = setInterval(() => {
      if (saved.current || saving.current || promptId.current === null) return;
      const checkGeneration = generation.current;
      void sendNative({ channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type: 'check', promptId: promptId.current }).then(result => {
        if (current && !saving.current && !saved.current && checkGeneration === generation.current && (result.status !== 'availability' || !result.available)) invalidate();
      }).catch(() => { if (current && !saving.current && !saved.current && checkGeneration === generation.current) invalidate(); });
    }, 5_000);
    return () => { current = false; generation.current++; clearInterval(timer); runtime?.onMessage?.removeListener(listener); };
  }, []);
  useEffect(() => {
    if (saved.current || saving.current) return;
    const request = ++generation.current;
    void sendNative({ channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type: 'get' }).then(result => {
      if (request !== generation.current || saved.current || saving.current) return;
      if (result.status !== 'review') { promptId.current = null; setReview(null); return; }
      promptId.current = result.review?.prompt.id ?? null;
      sourceTabId.current = result.sourceTabId ?? null;
      setReview(result.review);
    }).catch(() => { if (request === generation.current && !saved.current && !saving.current) setReview(null); });
  }, [revision]);
  const send: Send = async command => {
    const mutation = command.type === 'save' || command.type === 'confirm';
    if (mutation) saving.current = true;
    try {
      const result = await sendNative(command);
      if (mutation && result.status === 'saved') saved.current = true;
      return result;
    } finally { if (mutation) saving.current = false; }
  };
  return review ? <LoginCapturePrompt key={review.prompt.id} review={review} send={send}
    onSaved={() => { saved.current = true; promptId.current = null; setReview(value => value ? safeSummary(value) : null); }}
    onDone={() => { saved.current = false; promptId.current = null; setReview(null); }} /> : null;
}

export function LoginCapturePrompt({ review: initialReview, send, onDone, onSaved }: {
  review: NativeLoginCaptureReview; send: Send; onDone(): void; onSaved?(): void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [review, setReview] = useState(initialReview);
  const navigation = usePopupView();
  const [savedEntry, setSavedEntry] = useState<{vaultId:string;id:string} | null>(null);
  const [savedIdentity, setSavedIdentity] = useState<{name:string;icon?:string} | null>(null);
  const [stage, setStage] = useState<CaptureReviewStage>('notice');
  const [targetId, setTargetId] = useState(review.prompt.defaultTargetId ?? '');
  const [accountId, setAccountId] = useState(review.kind === 'federated' ? review.prompt.defaultAccountId ?? '' : '');
  const [entry, setEntry] = useState(review.kind === 'credential' ? review.entry : null);
  const [formVersion, setFormVersion] = useState(0);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  const target = review.prompt.targets.find(value => value.id === targetId);
  const account = review.kind === 'federated' ? review.prompt.accounts.find(value => value.id === accountId) : null;
  const provider = review.kind === 'federated' ? SIGN_IN_PROVIDER_NAMES[review.prompt.provider] : null;
  const federatedTarget = review.kind === 'federated' ? review.prompt.targets.find(value => value.id === targetId) : null;
  const replacing = review.kind === 'federated' && !!federatedTarget?.current
    && (federatedTarget.current.provider !== review.prompt.provider || !sameSignInAccount(federatedTarget.current.account, account?.source === 'none' ? null : account?.label ?? null));
  const channel = NATIVE_LOGIN_CAPTURE_CHANNEL;
  const formId = `login-capture-${review.prompt.id}`;

  async function selectTarget(value: string) {
    setTargetId(value); setAutoUpdate(false); setReplace(false); setError(false);
    if (review.kind !== 'credential' || !value) return;
    const generation = ++request.current;
    setBusy(true);
    try {
      const result = await send({ channel, type: 'get', targetId: value });
      if (!alive.current || request.current !== generation) return;
      if (result.status === 'review' && result.review?.kind === 'credential' && result.review.prompt.id === review.prompt.id) {
        setEntry(result.review.entry); setFormVersion(version => version + 1);
      } else { onDone(); }
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current && request.current === generation) setBusy(false); }
  }
  async function finish(command: NativeLoginCaptureCommand) {
    setBusy(true); setError(false);
    try {
      const result = await send(command);
      if (!alive.current) return false;
      if (result.status === 'saved') { setSavedIdentity({ name: command.type === 'save' ? command.entry.label : target?.label ?? review.prompt.site,
        ...(entry?.icon ? { icon: entry.icon } : {}) }); if (result.vaultId && result.entryId) setSavedEntry({ vaultId: result.vaultId, id: result.entryId }); setEntry(null); setReview(value => safeSummary(value)); setStage('saved'); onSaved?.(); return true; }
      if (result.status === 'stale' || result.status === 'dismissed') { onDone(); return false; }
      if (result.status === 'prompt' && result.prompt && review.kind === 'credential' && !('accounts' in result.prompt)) {
        setReview(value => value.kind === 'credential' ? { ...value, prompt: result.prompt! } as NativeLoginCaptureReview : value);
        setTargetId(result.prompt.defaultTargetId ?? '');
      }
      if (result.status === 'prompt' && result.prompt && review.kind === 'federated' && 'accounts' in result.prompt) {
        setReview({ ...review, prompt: result.prompt }); setTargetId(result.prompt.defaultTargetId ?? ''); setAccountId(result.prompt.defaultAccountId ?? '');
      }
      setError(true); return false;
    } catch { if (alive.current) setError(true); return false; }
    finally { if (alive.current) setBusy(false); }
  }
  async function chooseUsername(choice: 'email' | 'nickname') {
    setBusy(true); setError(false);
    try {
      const choiceResult = await send({ channel, type: 'choose-username', promptId: review.prompt.id, choice });
      if (!alive.current) return;
      if (choiceResult.status === 'stale') { onDone(); return; }
      const result = await send({ channel, type: 'get' });
      if (!alive.current) return;
      if (result.status === 'review' && result.review?.kind === 'credential') {
        setReview(result.review); setEntry(result.review.entry); setTargetId(result.review.prompt.defaultTargetId ?? '');
        setFormVersion(version => version + 1);
      } else onDone();
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current) setBusy(false); }
  }
  const name = savedIdentity?.name ?? entry?.label ?? target?.label ?? review.prompt.site;
  return <CaptureReview title={review.kind === 'credential' ? t('captureToast.title') : t('signInToast.title', { name: provider ?? '' })}
    savedTitle={review.kind === 'credential' ? t('captureToast.saved') : t('signInToast.saved')}
    origin={review.prompt.site} name={name} detail={stage === 'saved' ? '' : review.kind === 'credential' ? entry?.username ?? '' : account?.label ?? ''}
    identity={{ name, type: ENTRY_TYPE_CREDENTIAL, ...(savedIdentity?.icon ? { icon: savedIdentity.icon } : entry?.icon ? { icon: entry.icon } : review.kind === 'federated' && review.icon ? { icon: review.icon } : {}) }}
    identityTrailing={provider ? <span className="capture-provider" aria-label={provider} title={provider}>{review.kind === 'federated' && review.providerIcon ? <EntryIcon name={provider} type={ENTRY_TYPE_CREDENTIAL} icon={review.providerIcon} /> : provider.slice(0, 1)}</span> : undefined}
    stage={stage} vault={target?.vaultLabel ?? ''} busy={busy} disabled={!target || review.kind === 'federated' && (!account || replacing && !replace)}
    saveLabel={review.kind === 'credential' ? t('entry.save') : t('signIn.save')}
    {...(review.kind === 'credential' ? { saveForm: formId } : {})} {...(error ? { error: t('captureToast.error') } : {})}
    onIdentity={() => { if (stage === 'saved') { if (savedEntry && navigation) { navigation.update({ view: 'vault', selected: savedEntry }); onDone(); } return; } setStage('review'); requestAnimationFrame(() => document.getElementById(formId)?.querySelector<HTMLInputElement>('input')?.focus()); }}
    onReview={() => setStage('review')} onDone={onDone}
    onDismiss={() => void finish({ channel, type: 'dismiss', kind: review.kind, promptId: review.prompt.id })}
    onSave={() => { if (review.kind === 'federated' && target && account && (!replacing || replace)) void finish({ channel, type: 'confirm', promptId: review.prompt.id,
      targetId, accountId, locale: locale === 'pl' ? 'pl' : 'en', replace }); }}>
    {review.kind === 'credential' && review.prompt.usernameSelection ? <div>
      <p>{t('captureToast.chooseUsername')}</p>{(['email', 'nickname'] as const).map(choice => <Button key={choice} onClick={() => void chooseUsername(choice)}>{t(choice === 'email' ? 'captureToast.email' : 'captureToast.nickname')}</Button>)}
    </div> : null}
    {review.kind !== 'credential' || review.prompt.usernameSelection?.selected !== null ? <>
      <EntryAutocomplete label={t(review.kind === 'credential' ? 'captureToast.targets' : 'signInToast.whereToSave')}
        options={review.prompt.targets.map(value => ({ id: value.id, name: value.label, detail: value.vaultLabel, ...('icon' in value && value.icon ? { icon: value.icon } : {}), ...('color' in value && value.color ? { color: value.color } : {}), type: ENTRY_TYPE_CREDENTIAL }))}
        value={targetId} onValueChange={value => void selectTarget(value)} disabled={busy} />
      {review.kind === 'credential' && entry ? <AddEntryForm key={`${targetId}:${formVersion}`} client={vaultClient} initialEntry={entry}
        captureFormId={formId} onBusyChange={setBusy}
        afterCredentialUrl={target?.action === 'update' ? <label className="capture-checkbox"><input type="checkbox" checked={autoUpdate} onChange={event => setAutoUpdate(event.target.checked)} />{t('captureToast.autoUpdate')}</label> : undefined}
        onSave={async next => {
          if (next.entryType !== 'credential' || !target || busy) throw new Error('Capture target required');
          setEntry(next);
          if (!await finish({ channel, type: 'save', promptId: review.prompt.id, targetId, autoUpdate, entry: next })) throw new Error('Capture save failed');
          return { status: 'saved' };
        }} /> : null}
      {review.kind === 'federated' ? <>
        <EntryAutocomplete label={t('signInToast.whichAccount', { name: provider ?? '' })}
          options={review.prompt.accounts.map(value => ({ id: value.id, name: value.source === 'none' ? t('signInToast.accountUnknown') : value.label, ...(value.context ? { detail: value.context } : {}), ...(value.icon ? { icon: value.icon } : {}), type: ENTRY_TYPE_CREDENTIAL }))}
          value={accountId} onValueChange={value => { setAccountId(value); setReplace(false); }} disabled={busy} />
        {replacing ? <label className="capture-checkbox"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />{t('captureReview.replaceSignIn')}</label> : null}
      </> : null}
    </> : null}
  </CaptureReview>;
}
