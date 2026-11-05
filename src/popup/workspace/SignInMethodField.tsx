import googleLogo from '../assets/sign-in-providers/google.svg';
import appleLogo from '../assets/sign-in-providers/apple.svg';
import microsoftLogo from '../assets/sign-in-providers/microsoft.svg';
import githubLogo from '../assets/sign-in-providers/github.svg';
import facebookLogo from '../assets/sign-in-providers/facebook.svg';
import { useState } from 'react';
import { SIGN_IN_PROVIDERS, SIGN_IN_PROVIDER_NAMES, type SignInProvider } from '../../shared/signin/providers';
import type { EntrySignInView } from '../../shared/workspace/commands';
import { Button } from '../components/Button';
import { FilterSelect } from '../components/FilterSelect';
import { FormInput } from '../components/FormInput';
import { PopupIcon } from '../components/PopupIcon';
import { useI18n } from '../i18n';
import type { WorkspaceClient } from './client';

const providerLogos = { google: googleLogo, apple: appleLogo, microsoft: microsoftLogo, github: githubLogo, facebook: facebookLogo };

export interface MethodDraft { id: string; provider: SignInProvider; account: string | null; agentVisible: boolean }

/** Shared extension-owned editor; draft values stay in popup memory until encrypted save. */
export function SignInMethodsEditor({ methods, onSave, disabled = false }: {
 methods: readonly MethodDraft[];
 onSave(id: string | null, value: Omit<MethodDraft, 'id'> | null): Promise<void>;
 disabled?: boolean;
}): React.JSX.Element {
 const { t } = useI18n();
 const [editing, setEditing] = useState<string | null | undefined>(undefined);
 const [provider, setProvider] = useState<SignInProvider>('google');
 const [account, setAccount] = useState('');
 const [visible, setVisible] = useState(false);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState(false);
 function edit(method?: MethodDraft) {
  setEditing(method?.id ?? null); setProvider(method?.provider ?? 'google');
  setAccount(method?.account ?? ''); setVisible(method?.agentVisible ?? false); setError(false);
 }
 async function save(remove = false) {
  setBusy(true); setError(false);
  try { await onSave(editing ?? null, remove ? null : { provider, account: account.trim() || null, agentVisible: visible }); setEditing(undefined); }
  catch { setError(true); } finally { setBusy(false); }
 }
 return <section className="sign-in-methods" aria-label={t('signIn.section')}>
  <div className="entry-custom-fields-header"><h3>{t('signIn.section')}</h3>
   <button type="button" className="toolbar-icon" aria-label={t('signIn.add')} disabled={disabled || busy || methods.length >= 20} onClick={() => edit()}><PopupIcon name="plus" /></button>
  </div>
  {methods.map(method => <div key={method.id} className="detail-field sign-in-method-row">
   <img className="sign-in-provider-logo" src={providerLogos[method.provider]} alt="" />
   <span><span>{SIGN_IN_PROVIDER_NAMES[method.provider]}</span><small>{method.account ?? t('signIn.accountUnknown')}</small></span>
   <button type="button" className="toolbar-icon" aria-label={t('signIn.edit')} disabled={disabled || busy} onClick={() => edit(method)}><PopupIcon name="edit" /></button>
  </div>)}
  {editing !== undefined ? <div className="sign-in-method-form">
   <FilterSelect aria-label={t('signIn.provider')} value={provider} disabled={busy || disabled} onValueChange={value => setProvider(value as SignInProvider)}>
    {SIGN_IN_PROVIDERS.map(value => <option key={value} value={value}>{SIGN_IN_PROVIDER_NAMES[value]}</option>)}
   </FilterSelect>
   <FormInput type="text" label={t('signIn.account')} value={account} disabled={busy || disabled} maxLength={256} autoComplete="off" spellCheck={false} onChange={event => setAccount(event.target.value)} />
   <label><input type="checkbox" checked={visible} disabled={busy || disabled} onChange={event => setVisible(event.target.checked)} />{t('signIn.agentVisible')}</label>
   <div className="workspace-actions">
    {editing !== null ? <Button variant="danger" disabled={busy || disabled} onClick={() => void save(true)}>{t('signIn.remove')}</Button> : null}
    <Button variant="subtle" disabled={busy} onClick={() => setEditing(undefined)}>{t('signIn.cancel')}</Button>
    <Button loading={busy} disabled={disabled || account.trim().length > 256} onClick={() => void save()}>{t('signIn.save')}</Button>
   </div>
  </div> : null}
  {error ? <p role="alert">{t('signIn.error')}</p> : null}
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
