import { CAPTURE_DRAFT_CHANNEL, type CaptureDraft } from '../../shared/messaging/capture-draft';
import { useEffect, useState, useRef, type ComponentProps } from 'react';
import type { PendingCaptureRef } from '../../shared/messaging/popup-view';
import { NATIVE_LOGIN_CAPTURE_CHANNEL } from '../../shared/messaging/native-login-capture';
import { SECRET_CAPTURE_CHANNEL } from '../../shared/messaging/secret-capture';
import { TOTP_CAPTURE_CHANNEL } from '../../shared/messaging/totp-capture';
import { LoginCapturePrompt } from './LoginCapturePrompt';
import { SecretCapturePrompt } from './SecretCapturePrompt';
import { TotpCapturePrompt } from './TotpCapturePrompt';
import type { VaultClient } from '../vault/client';
import { useI18n } from '../i18n';
import { Button } from '../components/Button';
type Review = {kind:'login';value:ComponentProps<typeof LoginCapturePrompt>['review']} | {kind:'secret';value:ComponentProps<typeof SecretCapturePrompt>['review']} | {kind:'totp';value:ComponentProps<typeof TotpCapturePrompt>['review']};
export function PendingCaptureView({capture,client,onDone}:{capture:PendingCaptureRef;client:VaultClient;onDone():void}) {
  const {t}=useI18n();
  const handoffRequest=useRef<{key:string;promise:Promise<{draft:CaptureDraft|null}>}|null>(null);
  const clearDraft=()=>{handoffRequest.current=null;setDraft(null);};
  const [draft,setDraft]=useState<CaptureDraft|null>(null);
  const [review,setReview]=useState<Review|null>(null), [unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    let current=true;
    setReview(null);setUnavailable(false);
    void (async()=>{
      const key=`${capture.kind}:${capture.id}`;
      if(handoffRequest.current?.key!==key)handoffRequest.current={key,promise:chrome.runtime.sendMessage({channel:CAPTURE_DRAFT_CHANNEL,kind:capture.kind,id:capture.id})};
      const handoff=await handoffRequest.current.promise;
      if(!current)return;
      setDraft(handoff?.draft ?? null);
      if(capture.kind==='login') {
        const result: Awaited<ReturnType<ComponentProps<typeof LoginCapturePrompt>['send']>> = await chrome.runtime.sendMessage({channel:NATIVE_LOGIN_CAPTURE_CHANNEL,type:'get'});
        if(current && result.status==='review' && result.review?.prompt.id===capture.id){setReview({kind:'login',value:result.review});return;}
      } else if(capture.kind==='secret') {
        const result: Awaited<ReturnType<NonNullable<ComponentProps<typeof SecretCapturePrompt>['send']>>> = await chrome.runtime.sendMessage({channel:SECRET_CAPTURE_CHANNEL,type:'begin-review',id:capture.id});
        if(current && result.status==='review' && result.id===capture.id){setReview({kind:'secret',value:result});return;}
      } else {
        const result: Awaited<ReturnType<NonNullable<ComponentProps<typeof TotpCapturePrompt>['send']>>> = await chrome.runtime.sendMessage({channel:TOTP_CAPTURE_CHANNEL,type:'get'});
        if(current && result.status==='ready' && !result.entryScope && result.id===capture.id){setReview({kind:'totp',value:result});return;}
      }
      if(current)setUnavailable(true);
    })().catch(()=>{if(current)setUnavailable(true);});
    return()=>{current=false;};
  },[capture.kind,capture.id]);
  if(review?.kind==='login')return <LoginCapturePrompt initialExpanded initialDraft={draft?.kind==='login'?draft:undefined} client={client} review={review.value} send={command=>chrome.runtime.sendMessage(command)} onSaved={clearDraft} onDone={onDone}/>;
  if(review?.kind==='secret')return <SecretCapturePrompt initialExpanded initialDraft={draft?.kind==='secret'?draft:undefined} client={client} review={review.value} onSaved={clearDraft} onDone={onDone}/>;
  if(review?.kind==='totp')return <TotpCapturePrompt initialExpanded initialDraft={draft?.kind==='totp'?draft:undefined} review={review.value} onSaved={clearDraft} onDone={onDone}/>;
  return <div>{unavailable?<p role="status">{t('captureReview.unavailable')}</p>:null}<Button onClick={onDone}>{t('captureReview.done')}</Button></div>;
}
