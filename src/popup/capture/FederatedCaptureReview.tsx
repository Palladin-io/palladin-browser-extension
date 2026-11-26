import { useState } from 'react';
import type { CaptureDraft } from '../../shared/messaging/capture-draft';
import { NATIVE_LOGIN_CAPTURE_CHANNEL, type NativeLoginCaptureCommand, type NativeLoginCaptureResult, type NativeLoginCaptureReview } from '../../shared/messaging/native-login-capture';
import { SIGN_IN_PROVIDER_NAMES } from '../../shared/signin/providers';
import { sameSignInAccount } from '../../shared/signin/binding';
import { ENTRY_TYPE_CREDENTIAL } from '../../background/vault/entry-metadata';
import { EntryAutocomplete } from '../components/EntryAutocomplete';
import { FilterSelect } from '../components/FilterSelect';
import { FormInput } from '../components/FormInput';
import { useI18n } from '../i18n';
import { usePopupView } from '../view/PopupView';
import googleLogo from '../assets/sign-in-providers/google.svg';
import appleLogo from '../assets/sign-in-providers/apple.svg';
import microsoftLogo from '../assets/sign-in-providers/microsoft.svg';
import githubLogo from '../assets/sign-in-providers/github.svg';
import facebookLogo from '../assets/sign-in-providers/facebook.svg';
import { CaptureReview, type CaptureReviewStage } from './CaptureReview';

const providerLogos = { google: googleLogo, apple: appleLogo, microsoft: microsoftLogo, github: githubLogo, facebook: facebookLogo };
const monochromeProviders: readonly string[] = ['apple', 'github'];
/** Local marker for an account typed in this review; real account ids are opaque worker ids. */
const TYPED_ACCOUNT = 'typed';

type FederatedReview = Extract<NativeLoginCaptureReview, { kind: 'federated' }>;
type LoginDraft = Extract<CaptureDraft, { kind: 'login' }>;

export function FederatedCaptureReview({ review, send, onDone, onSaved, onOpenCapture, initialDraft, initialExpanded = false }: {
  review: FederatedReview;
  send(command: NativeLoginCaptureCommand): Promise<NativeLoginCaptureResult>;
  onDone(): void;
  onSaved?(): void;
  onOpenCapture?(saved: boolean, draft?: CaptureDraft): void;
  initialDraft?: LoginDraft | undefined;
  initialExpanded?: boolean;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const navigation = usePopupView();
  const { prompt } = review;
  const provider = SIGN_IN_PROVIDER_NAMES[prompt.provider];
  const updates = prompt.targets.filter(item => item.action === 'update');
  const creates = prompt.targets.filter(item => item.action === 'create');
  const [accountId, setAccountId] = useState(initialDraft?.accountId ?? prompt.defaultAccountId ?? '');
  const [typed, setTyped] = useState('');
  const [targetId, setTargetId] = useState(initialDraft?.targetId || prompt.defaultTargetId || updates[0]?.id || creates[0]?.id || '');
  const [entryName, setEntryName] = useState(initialDraft?.entryName ?? prompt.site);
  const [editing, setEditing] = useState(false);
  const [replace, setReplace] = useState(initialDraft?.replace ?? false);
  const [stage, setStage] = useState<CaptureReviewStage>(initialExpanded ? 'review' : 'notice');
  // The frame clears accounts after saving, so only the confirmed label is kept.
  const [savedLabel, setSavedLabel] = useState('');
  const [savedEntry, setSavedEntry] = useState<{ vaultId: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const account = prompt.accounts.find(item => item.id === accountId);
  const target = prompt.targets.find(item => item.id === targetId);
  const creating = target?.action === 'create';
  const typedAccount = accountId === TYPED_ACCOUNT ? typed.trim() : '';
  const accountLabel = typedAccount || (account?.source === 'none' ? t('signInToast.accountUnknown') : account?.label ?? '');
  const binding = typedAccount || (account && account.source !== 'none' ? account.label : null);
  const replacing = !!target?.current && (target.current.provider !== prompt.provider || !sameSignInAccount(target.current.account, binding));
  const ready = !!accountLabel && !!target && (!creating || !!entryName.trim()) && (!replacing || replace);
  const name = target?.action === 'update' ? target.label : entryName.trim() || prompt.site;

  function typeAccount(value: string) {
    const same = prompt.accounts.filter(item => item.source !== 'none' && item.label.toLowerCase() === value.trim().toLowerCase());
    setTyped(value);
    setAccountId(same.length === 1 ? same[0]!.id : value.trim() ? TYPED_ACCOUNT : '');
    setReplace(false);
  }
  function chooseTarget(id: string, edit: boolean) { setTargetId(id); setEditing(edit); setReplace(false); }
  async function finish(type: 'confirm' | 'dismiss' | 'mute') {
    if (type === 'confirm' && (!ready || !target)) return;
    setBusy(true); setError(false);
    try {
      const result = await send(type === 'confirm'
        ? { channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type, promptId: prompt.id, targetId, locale: locale === 'pl' ? 'pl' : 'en', replace,
          ...(typedAccount ? { account: typedAccount } : { accountId }), ...(creating ? { entryName: entryName.trim() } : {}) }
        : { channel: NATIVE_LOGIN_CAPTURE_CHANNEL, type, kind: 'federated', promptId: prompt.id });
      if (result.status === 'saved') {
        setSavedLabel(accountLabel); setStage('saved');
        if ('vaultId' in result && result.vaultId && 'entryId' in result && result.entryId) setSavedEntry({ vaultId: result.vaultId, id: result.entryId });
        onSaved?.();
      } else if (result.status === 'stale' || result.status === 'dismissed') onDone();
      else setError(true);
    } catch { setError(true); } finally { setBusy(false); }
  }

  return <CaptureReview title={t('captureReview.rememberMethod')} savedTitle={t('captureReview.methodSaved')} origin={prompt.site}
    name={name} detail={stage === 'saved' ? `${provider} · ${savedLabel}` : creating ? t('captureReview.newEntryIn', { vault: target.vaultLabel })
      : target ? t('captureReview.vaultLocation', { name: target.vaultLabel }) : ''}
    identity={{ name, type: ENTRY_TYPE_CREDENTIAL, ...(review.icon ? { icon: review.icon } : {}) }}
    identityTrailing={<span className="capture-provider"><img className="sign-in-provider-logo" data-provider={prompt.provider} src={providerLogos[prompt.provider]} alt={provider} /></span>}
    stage={stage} vault={target?.vaultLabel ?? ''} busy={busy} disabled={!ready} saveLabel={t('common.save')}
    {...(error ? { error: t('captureToast.error') } : {})}
    {...(onOpenCapture ? { onIdentity: () => onOpenCapture(stage === 'saved', { kind: 'login', targetId, accountId: accountId === TYPED_ACCOUNT ? '' : accountId,
      methodMode: creating ? 'create' : 'update', entryName, autoUpdate: false, replace, form: null }) }
      : stage === 'saved' && savedEntry && navigation ? { onIdentity: () => { navigation.update({ view: 'vault', selected: savedEntry }); onDone(); } } : {})}
    menuActions={[
      ...(creating && !editing ? [{ label: t('captureReview.editEntry'), onSelect: () => setEditing(true) }] : []),
      ...updates.filter(item => item.id !== targetId).map(item => ({
        label: t('captureReview.addTo', { name: updates.length > 1 ? t('captureReview.entryInVault', { name: item.label, vault: item.vaultLabel }) : item.label }),
        onSelect: () => chooseTarget(item.id, false) })),
      ...(!creating && creates.length ? [{ label: t('captureReview.createEntry'), onSelect: () => chooseTarget(creates[0]!.id, true) }] : []),
    ]}
    onReview={() => setStage('review')} onDone={onDone} onDismiss={() => void finish('dismiss')} onMute={() => void finish('mute')} onSave={() => void finish('confirm')}>
    <EntryAutocomplete label={t('signInToast.whichAccount', { name: provider })} placeholder={t('signInToast.accountPlaceholder')} value={accountId} disabled={busy}
      showIcon logo={providerLogos[prompt.provider]} logoMono={monochromeProviders.includes(prompt.provider)}
      customValue={accountId === TYPED_ACCOUNT ? typed : ''} onCustomValue={typeAccount}
      onValueChange={value => { setAccountId(value); setReplace(false); }}
      options={prompt.accounts.map(item => ({ id: item.id, name: item.source === 'none' ? t('signInToast.skipAccount') : item.label, type: ENTRY_TYPE_CREDENTIAL,
        ...(item.source === 'none' ? { plain: true } : {}), ...(item.icon ? { icon: item.icon } : {}), ...(item.context ? { detail: item.context } : {}) }))} />
    {creating && editing ? <>
      <FormInput type="text" label={t('captureReview.entryName')} value={entryName} maxLength={512} autoComplete="off" disabled={busy} onChange={event => setEntryName(event.target.value)} />
      {creates.length > 1 ? <>
        <label className="field-label">{t('captureReview.vault')}</label>
        <FilterSelect floating aria-label={t('captureReview.vault')} value={targetId} disabled={busy} onValueChange={setTargetId}>
          {creates.map(item => <option key={item.id} value={item.id}>{item.vaultLabel}</option>)}
        </FilterSelect>
      </> : null}
    </> : null}
    {replacing ? <label className="capture-checkbox"><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />{t('captureReview.replaceSignIn')}</label> : null}
  </CaptureReview>;
}
