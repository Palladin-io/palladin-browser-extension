import { normalizeSignInAccount } from '../../shared/signin/binding';
import googleLogo from '../assets/sign-in-providers/google.svg';
import appleLogo from '../assets/sign-in-providers/apple.svg';
import microsoftLogo from '../assets/sign-in-providers/microsoft.svg';
import githubLogo from '../assets/sign-in-providers/github.svg';
import facebookLogo from '../assets/sign-in-providers/facebook.svg';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIGN_IN_PROVIDER_NAMES, type SignInProvider } from '../../shared/signin/providers';
import type { EntrySignInView } from '../../shared/workspace/commands';
import { Button } from '../components/Button';
import { FormInput } from '../components/FormInput';
import { PopupIcon } from '../components/PopupIcon';
import { useI18n } from '../i18n';
import type { WorkspaceClient } from './client';

const PROVIDER_DISPLAY_ORDER = ['google', 'github', 'apple', 'microsoft', 'facebook'] as const satisfies readonly SignInProvider[]

const providerLogos = { google: googleLogo, apple: appleLogo, microsoft: microsoftLogo, github: githubLogo, facebook: facebookLogo };

export interface MethodDraft { id: string; provider: SignInProvider; account: string | null; agentVisible: boolean }

/** Shared extension-owned editor; draft values stay in popup memory until encrypted save. */
export function SignInMethodsEditor({ methods, onSave, disabled = false }: {
 methods: readonly MethodDraft[];
 onSave(id: string | null, value: Omit<MethodDraft, 'id'> | null): Promise<void>;
 disabled?: boolean;
}): React.JSX.Element {
 const { t } = useI18n();
 const dialog = useRef<HTMLDialogElement>(null);
 const trigger = useRef<HTMLButtonElement | null>(null);
 const addTrigger = useRef<HTMLButtonElement>(null);
 const [editing, setEditing] = useState<string | null | undefined>(undefined);
 const [provider, setProvider] = useState<SignInProvider>('google');
 const [account, setAccount] = useState('');
 const [visible, setVisible] = useState(false);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState(false);
 useEffect(() => {
  if (editing !== undefined) dialog.current?.showModal();
  else if (trigger.current) {
   (trigger.current.isConnected ? trigger.current : addTrigger.current)?.focus();
   trigger.current = null;
  }
 }, [editing]);
 // Release native modal inertness before restoring focus after React commits.
 function finish() { dialog.current?.close(); setEditing(undefined); }
 function close() { if (!busy) finish(); }
 function edit(method?: MethodDraft) {
  trigger.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  setEditing(method?.id ?? null); setProvider(method?.provider ?? 'google');
  setAccount(method?.account ?? ''); setVisible(method?.agentVisible ?? false); setError(false);
 }
 async function save(remove = false) {
  setBusy(true); setError(false);
  try { await onSave(editing ?? null, remove ? null : { provider, account: normalizeSignInAccount(account), agentVisible: visible }); finish(); }
  catch { setError(true); } finally { setBusy(false); }
 }
 return <section className="sign-in-methods" aria-label={t('signIn.section')}>
  <div className="entry-custom-fields-header sign-in-methods-header"><h3>{t('signIn.section')}</h3>
   <button ref={addTrigger} type="button" className="toolbar-icon" aria-label={t('signIn.add')} disabled={disabled || busy || methods.length >= 20} onClick={() => edit()}><PopupIcon name="plus" /></button>
  </div>
  {methods.map(method => <div key={method.id} className="detail-field sign-in-method-row">
   <img className="sign-in-provider-logo" data-provider={method.provider} src={providerLogos[method.provider]} alt="" />
   <span><span>{SIGN_IN_PROVIDER_NAMES[method.provider]}</span><small>{method.account ?? t('signIn.accountUnknown')}</small></span>
   <button type="button" className="toolbar-icon" aria-label={t('signIn.edit')} disabled={disabled || busy} onClick={() => edit(method)}><PopupIcon name="edit" /></button>
  </div>)}
  {editing !== undefined ? createPortal(<dialog ref={dialog} className="entry-icon-dialog sign-in-method-dialog" aria-label={t(editing === null ? 'signIn.add' : 'signIn.edit')} onCancel={event => { event.preventDefault(); close(); }}>
   <div className="entry-icon-picker-heading sign-in-method-dialog-heading">
    <strong>{t(editing === null ? 'signIn.add' : 'signIn.edit')}</strong>
    <button type="button" className="toolbar-icon" aria-label={t('icon.close')} disabled={busy} onClick={close}>×</button>
   </div>
   <div className="sign-in-method-form">
    <p className="sign-in-method-hint">{t('signIn.editorHint')}</p>
    <div className="sign-in-provider-choices" role="group" aria-label={t('signIn.provider')}>
     {PROVIDER_DISPLAY_ORDER.map(value => <button key={value} type="button" className="sign-in-provider-choice" aria-pressed={provider === value} disabled={busy || disabled} onClick={() => setProvider(value)}>
      <img className="sign-in-provider-logo" data-provider={value} src={providerLogos[value]} alt="" /><span>{SIGN_IN_PROVIDER_NAMES[value]}</span>
     </button>)}
    </div>
    <h3 className="sign-in-account-heading">{t('signIn.providerAccountTitle', { provider: SIGN_IN_PROVIDER_NAMES[provider] })}</h3>
    <FormInput type="text" label={t('signIn.account')} value={account} disabled={busy || disabled} maxLength={256} autoComplete="off" spellCheck={false} onChange={event => setAccount(event.target.value)} />
    <label className="generator-check sign-in-visibility"><span><span>{t('signIn.agentVisible')}</span><small>{t('signIn.visibilityHint')}</small></span><input type="checkbox" checked={visible} disabled={busy || disabled} onChange={event => setVisible(event.target.checked)} /></label>
    {editing !== null ? <Button variant="ghost" disabled={busy || disabled} onClick={() => void save(true)}>{t('signIn.remove')}</Button> : null}
    {error ? <p role="alert">{t('signIn.error')}</p> : null}
   </div>
   <div className="entry-icon-picker-footer sign-in-method-dialog-footer">
    <Button variant="subtle" disabled={busy} onClick={close}>{t('signIn.cancel')}</Button>
    <Button loading={busy} disabled={disabled || account.trim().length > 256} onClick={() => void save()}>{t('signIn.save')}</Button>
   </div>
  </dialog>, document.body) : null}
 </section>;
}

export function SignInMethodField({ client, vaultId, entryId, view, onChanged }: {
 client: WorkspaceClient; vaultId: string; entryId: string; view: EntrySignInView; onChanged(next: EntrySignInView): void;
}): React.JSX.Element | null {
 const { locale } = useI18n();
 if (view.status === 'unsupported') return null;
 return <SignInMethodsEditor methods={view.methods} onSave={async (fieldId, binding) => {
  await client.send({ type: 'workspace/sign-in', vaultId, entryId, fieldId, binding: binding ? { provider: binding.provider, account: binding.account } : null,
   agentVisible: binding?.agentVisible ?? false, locale: locale === 'pl' ? 'pl' : 'en' });
  const result = await client.send({ type: 'workspace/detail', vaultId, entryId });
  if (result.signIn) onChanged(result.signIn);
 }} />;
}
