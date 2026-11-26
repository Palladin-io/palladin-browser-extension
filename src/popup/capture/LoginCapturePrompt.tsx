import type { CaptureDraft, CaptureFormDraft } from '../../shared/messaging/capture-draft';
import { FilterSelect } from '../components/FilterSelect';
import { useEffect, useRef, useState } from 'react';
import { ENTRY_TYPE_CREDENTIAL } from '../../background/vault/entry-metadata';
import { NATIVE_LOGIN_CAPTURE_CHANNEL, type CapturedLoginEntry, type NativeLoginCaptureCommand, type NativeLoginCaptureResult, type NativeLoginCaptureReview } from '../../shared/messaging/native-login-capture';
import type { CredentialCapturePrompt } from '../../shared/messaging/credential-capture';
import { PopupIcon } from '../components/PopupIcon';
import { FederatedCaptureReview } from './FederatedCaptureReview';
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
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const saved = useRef(false), saving = useRef(false), generation = useRef(0);
  const sourceTabId = useRef<number | null>(null), promptId = useRef<string | null>(null);
  useEffect(() => {
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    let current = true;
    const invalidate = () => { generation.current++; if (!saved.current) { promptId.current = null; setReview(null); } };
    const listener = (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)
        || 'tabId' in message && sourceTabId.current !== null && message.tabId !== sourceTabId.current) return;
      if (message.type === 'login-capture/invalidated') invalidate();
      else if (message.type === 'login-capture/available' && !saved.current && !saving.current) setAvailabilityRevision(value => value + 1);
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
  }, [revision, availabilityRevision]);
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

export function LoginCapturePrompt(props: {
  initialDraft?: Extract<CaptureDraft,{kind:'login'}> | undefined; onOpenCapture?(saved: boolean, draft?: CaptureDraft): void; initialExpanded?: boolean; client?: ReturnType<typeof createVaultClient>; review: NativeLoginCaptureReview; send: Send; onDone(): void; onSaved?(): void;
}): React.JSX.Element {
  const { review, ...rest } = props;
  return review.kind === 'federated'
    ? <FederatedCaptureReview review={review} send={props.send} onDone={props.onDone} {...(props.onSaved ? { onSaved: props.onSaved } : {})}
      {...(props.onOpenCapture ? { onOpenCapture: props.onOpenCapture } : {})} initialDraft={props.initialDraft} initialExpanded={props.initialExpanded ?? false} />
    : <CredentialCaptureReview review={review} {...rest} />;
}

function CredentialCaptureReview({ review: initialReview, send, onDone, onSaved, onOpenCapture, initialDraft, initialExpanded = false, client = vaultClient }: {
  initialDraft?: Extract<CaptureDraft,{kind:'login'}> | undefined; onOpenCapture?(saved: boolean, draft?: CaptureDraft): void; initialExpanded?: boolean; client?: ReturnType<typeof createVaultClient>;
  review: Extract<NativeLoginCaptureReview, { kind: 'credential' }>; send: Send; onDone(): void; onSaved?(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [review, setReview] = useState(initialReview);
  const navigation = usePopupView();
  const [savedEntry, setSavedEntry] = useState<{vaultId:string;id:string} | null>(null);
  const [savedIdentity, setSavedIdentity] = useState<{name:string;detail:string;icon?:string} | null>(null);
  const [stage, setStage] = useState<CaptureReviewStage>(initialExpanded ? 'review' : 'notice');
  const [targetId, setTargetId] = useState(initialDraft?.targetId ?? review.prompt.defaultTargetId ?? '');
  const [entry, setEntry] = useState<CapturedLoginEntry | null>(review.entry);
  const [formVersion, setFormVersion] = useState(0);
  const [autoUpdate, setAutoUpdate] = useState(initialDraft?.autoUpdate ?? false);
  // A restored handoff reopens the fields the user was editing.
  const [more, setMore] = useState(!!initialDraft?.form);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const formDraft=useRef<CaptureFormDraft|null>(initialDraft?.form ?? null);
  const restoredForm=useRef(initialDraft?.form ?? undefined);
  const alive = useRef(true);
  const request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  const target = review.prompt.targets.find(value => value.id === targetId);
  const channel = NATIVE_LOGIN_CAPTURE_CHANNEL;
  const formId = `login-capture-${review.prompt.id}`;
  const usernameChoice = review.prompt.usernameSelection?.selected;
  useEffect(() => {
    // Sign-up reviews start with the e-mail candidate; the user can switch to the nickname before saving.
    if (usernameChoice === null && review.usernameOptions) void chooseUsername('email');
    // Without a worker default, the first matching entry is reviewed with its own worker-supplied fields.
    else if (!targetId) { const first = review.prompt.targets.find(value => value.action === 'update'); if (first) void selectTarget(first.id); }
  }, []);

  async function selectTarget(value: string) {
    restoredForm.current=undefined; formDraft.current=null;
    setTargetId(value); setAutoUpdate(false); setError(false);
    if (!value) return;
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
      if (result.status === 'saved') { formDraft.current=null;restoredForm.current=undefined; setSavedIdentity({ name: command.type === 'save' ? command.entry.label : target?.label ?? review.prompt.site,
        detail: command.type === 'save' ? command.entry.username : '',
        ...(entry?.icon ? { icon: entry.icon } : {}) }); if (result.vaultId && result.entryId) setSavedEntry({ vaultId: result.vaultId, id: result.entryId }); setEntry(null); setReview(value => safeSummary(value) as typeof value); setStage('saved'); onSaved?.(); return true; }
      if (result.status === 'stale' || result.status === 'dismissed') { onDone(); return false; }
      if (result.status === 'prompt' && result.prompt && !('accounts' in result.prompt)) {
        setReview(value => ({ ...value, prompt: result.prompt as CredentialCapturePrompt }));
        setTargetId(result.prompt.defaultTargetId ?? '');
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
  const updating = review.prompt.targets.some(value => value.action === 'update');
  // A restored handoff keeps the full editor so the user's unsaved field edits stay visible.
  const quickUpdate = target?.action === 'update' && !restoredForm.current;
  const usernameOptions = review.usernameOptions && usernameChoice
    ? (['email', 'nickname'] as const).map(kind => ({ value: review.usernameOptions![kind], kind })) : undefined;
  const name = savedIdentity?.name ?? entry?.label ?? target?.label ?? review.prompt.site;
  const creating = !updating || target?.action === 'create';
  const vaultChoice = creating ? <div className="capture-vault-choice">
    <label className="field-label">{t('captureReview.vault')}</label>
    <FilterSelect floating aria-label={t('captureReview.vault')} value={targetId} disabled={busy} onValueChange={value => void selectTarget(value)}>
      {review.prompt.targets.filter(value => value.action === 'create').map(value => <option value={value.id} key={value.id}>{value.vaultLabel}</option>)}
    </FilterSelect>
  </div> : undefined;
  const autoUpdateOption = <label className="capture-checkbox"><input type="checkbox" checked={autoUpdate} onChange={event => setAutoUpdate(event.target.checked)} />{t('captureToast.autoUpdate')}</label>;
  return <CaptureReview title={t(updating ? 'captureReview.updatePassword' : 'captureReview.saveLogin')}
    savedTitle={t(updating ? 'captureReview.passwordUpdated' : 'captureToast.saved')}
    origin={review.prompt.site} name={name} detail={savedIdentity?.detail ?? entry?.username ?? ''}
    identity={{ name, type: ENTRY_TYPE_CREDENTIAL, ...(savedIdentity?.icon ? { icon: savedIdentity.icon } : entry?.icon ? { icon: entry.icon } : {}) }}
    stage={stage} vault={target?.vaultLabel ?? ''} busy={busy} disabled={!target}
    saveLabel={t(updating ? 'captureReview.updatePassword' : 'captureReview.saveLogin')} {...(quickUpdate ? {} : { saveForm: formId })} {...(error ? { error: t('captureToast.error') } : {})}
    {...(onOpenCapture ? {onIdentity: () => onOpenCapture(stage === 'saved',{kind:'login',targetId,accountId:'',methodMode:'update',entryName:'',autoUpdate,replace:false,form:formDraft.current})} : stage === 'saved' && savedEntry && navigation ? {onIdentity: () => { navigation.update({view:'vault',selected:savedEntry});onDone(); }} : {})}
    menuActions={updating ? [
      ...review.prompt.targets.filter(value => value.action === 'update' && value.id !== targetId).map(value => ({
        label: t('captureReview.changeEntry', { name: t('captureReview.entryInVault', { name: value.label, vault: value.vaultLabel }) }), onSelect: () => void selectTarget(value.id) })),
      ...(quickUpdate ? review.prompt.targets.filter(value => value.action === 'create').slice(0, 1).map(value => ({
        label: t('captureReview.createEntry'), onSelect: () => void selectTarget(value.id) })) : []),
    ] : []}
    onReview={() => setStage('review')} onDone={onDone}
    onDismiss={() => void finish({ channel, type: 'dismiss', kind: 'credential', promptId: review.prompt.id })}
    onMute={() => void finish({ channel, type: 'mute', kind: 'credential', promptId: review.prompt.id })}
    onSave={() => { if (quickUpdate && entry && !busy) void finish({ channel, type: 'save', promptId: review.prompt.id, targetId, autoUpdate, entry }); }}>
    {quickUpdate && entry ? <>
      <label><span className="field-label">{t('captureReview.newPassword')}</span><span className="entry-reveal-field">
        <input className="field-input" readOnly type={showPassword ? 'text' : 'password'} value={entry.password} />
        <button type="button" className="toolbar-icon" aria-label={`${t(showPassword ? 'field.hide' : 'field.show')} ${t('captureReview.newPassword')}`} aria-pressed={showPassword}
          onClick={() => setShowPassword(value => !value)}><PopupIcon name={showPassword ? 'eye-off' : 'eye'} /></button>
      </span></label>
      {autoUpdateOption}
    </> : null}
    {review.prompt.usernameSelection?.selected !== null && entry && !quickUpdate ? <AddEntryForm key={`${targetId}:${formVersion}`} client={client} initialEntry={entry} captureDraftRef={formDraft} initialCaptureDraft={restoredForm.current}
        captureFormId={formId} capturePasswordUpdate={!creating} onBusyChange={setBusy}
        {...(creating ? { compact: { ...(vaultChoice ? { slot: vaultChoice } : {}), open: more, onOpenChange: setMore } } : {})}
        {...(usernameOptions ? { usernameOptions, onUsernameChange: (value: string) => {
          const choice = usernameOptions.find(option => option.value === value)?.kind; if (choice && choice !== usernameChoice) void chooseUsername(choice);
        } } : {})}
        afterCredentialUrl={target?.action === 'update' ? autoUpdateOption : undefined}
        onSave={async next => {
          if (next.entryType !== 'credential' || !target || busy) throw new Error('Capture target required');
          setEntry(next);
          if (!await finish({ channel, type: 'save', promptId: review.prompt.id, targetId, autoUpdate, entry: next })) throw new Error('Capture save failed');
          return { status: 'saved' };
        }} /> : null}
  </CaptureReview>;
}
