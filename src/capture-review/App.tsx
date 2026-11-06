import type { CaptureDraft } from '../shared/messaging/capture-draft';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ApiUrlContext } from '../popup/components/PublicAssetImages';
import captureBrand from '../../icons/icon-128.png';
import { LoginCapturePrompt } from '../popup/capture/LoginCapturePrompt';
import { SecretCapturePrompt } from '../popup/capture/SecretCapturePrompt';
import { TotpCapturePrompt } from '../popup/capture/TotpCapturePrompt';
import { CaptureReview } from '../popup/capture/CaptureReview';
import { createVaultClient } from '../popup/vault/client';
import { useI18n } from '../popup/i18n';
import { ENTRY_TYPE_CREDIT_CARD, ENTRY_TYPE_KEY } from '../background/vault/entry-metadata';
import { NATIVE_LOGIN_CAPTURE_CHANNEL } from '../shared/messaging/native-login-capture';
import { SECRET_CAPTURE_CHANNEL } from '../shared/messaging/secret-capture';
import { TOTP_CAPTURE_CHANNEL } from '../shared/messaging/totp-capture';
import type { CaptureFrameConnection } from './frame-connection';

type LoginProps = ComponentProps<typeof LoginCapturePrompt>;
type SecretProps = ComponentProps<typeof SecretCapturePrompt>;
type TotpProps = ComponentProps<typeof TotpCapturePrompt>;
type Review = { kind: 'login'; value: LoginProps['review'] } | { kind: 'secret'; value: SecretProps['review'] } | { kind: 'totp'; value: TotpProps['review'] };
type SavedSecret = Parameters<NonNullable<SecretProps['onSaved']>>[0];
// Shared editors use their injected capture onSave. Any accidental generic Vault call fails closed.
const noVaultCommands = createVaultClient(async () => { throw new Error('Capture-only surface'); });

export function CaptureFrameApp({ connection }: { connection: CaptureFrameConnection }) {
  const { t } = useI18n();
  const [review, setReview] = useState<Review | null>(null);
  const [savedSecret, setSavedSecret] = useState<SavedSecret | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    const channel = connection.kind === 'login' ? NATIVE_LOGIN_CAPTURE_CHANNEL : connection.kind === 'secret' ? SECRET_CAPTURE_CHANNEL : TOTP_CAPTURE_CHANNEL;
    void connection.send({ channel, type: 'get' }).then(result => {
      if (!current) return;
      if (connection.kind === 'login' && result.status === 'review' && 'review' in result && result.review) setReview({ kind: 'login', value: result.review });
      else if (connection.kind === 'secret' && result.status === 'review' && 'candidate' in result) setReview({ kind: 'secret', value: result });
      else if (connection.kind === 'totp' && result.status === 'ready' && !result.entryScope) setReview({ kind: 'totp', value: result });
      else connection.close();
    }).catch(() => { if (current) connection.failed(); });
    return () => { current = false; };
  }, [connection]);
  useEffect(() => {
    if (review || savedSecret) connection.ready();
  }, [connection, review, savedSecret]);
  useEffect(() => {
    const node = container.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => connection.resize(node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [connection]);
  const openCapture = (saved: boolean, draft?: CaptureDraft) => { if(!saved && !draft)return; void connection.send(saved ? {type:'open-saved'} : {type:'open-draft',draft:draft!}).then(result => { if (result.status === 'dismissed') connection.close(); }).catch(connection.failed); };
  return <ApiUrlContext.Provider value={connection.apiUrl}><div className="popup capture-frame" ref={container}>
    <header className="popup-header"><div className="brand-lockup"><img className="brand-logo" src={captureBrand} alt="" /><h1 className="wordmark" aria-label="Palladin.io">Palladin<span className="wordmark-tld">.io</span></h1></div><button type="button" className="toolbar-icon" aria-label={t('captureReview.close')} onClick={connection.close}><span aria-hidden="true">×</span></button></header>
    {review?.kind === 'login' ? <LoginCapturePrompt initialExpanded onOpenCapture={openCapture} client={noVaultCommands} review={review.value}
      send={command => connection.send(command) as ReturnType<LoginProps['send']>} onDone={connection.close}
      onSaved={() => setReview(current => current?.kind !== 'login' ? current : { kind: 'login', value: current.value.kind === 'credential'
        ? { ...current.value, entry: { entryType: 'credential', label: current.value.entry.label, username: '', password: '' } }
        : { ...current.value, prompt: { ...current.value.prompt, accounts: [] } } })} /> : null}
    {review?.kind === 'secret' ? <SecretCapturePrompt initialExpanded onOpenCapture={openCapture} client={noVaultCommands} review={review.value}
      send={command => connection.send(command) as ReturnType<NonNullable<SecretProps['send']>>} onDone={connection.close}
      onSaved={summary => { setReview(null); setSavedSecret(summary); }} /> : null}
    {review?.kind === 'totp' ? <TotpCapturePrompt initialExpanded onOpenCapture={openCapture} review={review.value}
      send={command => connection.send(command) as ReturnType<NonNullable<TotpProps['send']>>} onDone={connection.close} /> : null}
    {savedSecret ? <CaptureReview title="" savedTitle={t(savedSecret.card ? savedSecret.updated ? 'captureReview.cardUpdated' : 'captureReview.cardSaved' : 'captureReview.keySaved')}
      stage="saved" origin={savedSecret.origin} name={savedSecret.name} detail={savedSecret.detail} vault={savedSecret.vault}
      identity={{ name: savedSecret.name, type: savedSecret.card ? ENTRY_TYPE_CREDIT_CARD : ENTRY_TYPE_KEY, ...(savedSecret.icon ? { icon: savedSecret.icon } : {}) }}
      saveLabel="" onIdentity={() => openCapture(true)} onReview={() => {}} onSave={() => {}} onDismiss={connection.close} onDone={connection.close}>{null}</CaptureReview> : null}
  </div></ApiUrlContext.Provider>;
}
