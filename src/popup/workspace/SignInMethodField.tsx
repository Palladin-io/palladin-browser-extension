import { useState } from 'react';
import { SIGN_IN_PROVIDERS, SIGN_IN_PROVIDER_NAMES, type SignInProvider } from '../../shared/signin/providers';
import type { EntrySignInView } from '../../shared/workspace/commands';
import { Button } from '../components/Button';
import { FilterSelect } from '../components/FilterSelect';
import { FormInput } from '../components/FormInput';
import { useI18n } from '../i18n';
import type { WorkspaceClient } from './client';

/**
 * Shows and edits the encrypted federated sign-in method of one Credential.
 * The popup is extension-owned UI, so the account may be typed here; it is
 * written only into the encrypted MemberSecret with Agent access `never`.
 */
export function SignInMethodField({
  client, vaultId, entryId, view, onChanged,
}: {
  client: WorkspaceClient;
  vaultId: string;
  entryId: string;
  view: EntrySignInView;
  onChanged(next: EntrySignInView): void;
}): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<SignInProvider>(view.status === 'recognized' ? view.provider : 'google');
  const [account, setAccount] = useState(view.status === 'recognized' ? view.account ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (view.status === 'unsupported') return null;

  async function save(binding: { provider: SignInProvider; account: string | null } | null) {
    setBusy(true);
    setError(false);
    try {
      await client.send({ type: 'workspace/sign-in', vaultId, entryId, binding, locale: locale === 'pl' ? 'pl' : 'en' });
      setEditing(false);
      onChanged(binding === null ? { status: 'absent' } : { status: 'recognized', ...binding,
        linked: view.status === 'recognized' && view.linked && view.provider === binding.provider
          && (view.account ?? '').toLocaleLowerCase('en') === (binding.account ?? '').toLocaleLowerCase('en'),
        agentVisible: view.status === 'recognized' ? view.agentVisible : false });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const trimmed = account.trim();
  const tooLong = trimmed.length > 256;
  const summary = view.status === 'recognized'
    ? `${SIGN_IN_PROVIDER_NAMES[view.provider]} · ${view.account ?? t('signIn.accountUnknown')}`
    : view.status === 'absent' ? t('signIn.none') : t('signIn.unrecognized');

  return (
    <div className="detail-field sign-in-method" aria-label={t('signIn.section')}>
      <span>
        <small>{t('signIn.section')}</small>
        {!editing ? <span className="detail-field-value">{summary}</span> : null}
        {!editing && view.status === 'recognized' && view.agentVisible ? (
          <span className="entry-status">{t(view.linked ? 'signIn.agentVisibleLinked' : 'signIn.agentVisible')}</span>
        ) : null}
        {!editing ? null : (
          <span className="sign-in-method-form">
            <FilterSelect aria-label={t('signIn.provider')} value={provider} disabled={busy}
              onChange={(event) => setProvider(event.target.value as SignInProvider)}>
              {SIGN_IN_PROVIDERS.map((value) => <option key={value} value={value}>{SIGN_IN_PROVIDER_NAMES[value]}</option>)}
            </FilterSelect>
            <FormInput label={t('signIn.account')} placeholder={t('signIn.accountHint')} value={account} disabled={busy}
              autoComplete="off" spellCheck={false} maxLength={300}
              {...(tooLong ? { error: t('signIn.tooLong') } : {})}
              onChange={(event) => setAccount(event.target.value)} />
            <span className="workspace-actions">
              <Button variant="subtle" disabled={busy} onClick={() => { setEditing(false); setError(false); }}>{t('signIn.cancel')}</Button>
              <Button loading={busy} disabled={tooLong}
                onClick={() => void save({ provider, account: trimmed.length === 0 ? null : trimmed })}>
                {t(busy ? 'signIn.saving' : 'signIn.save')}
              </Button>
            </span>
          </span>
        )}
        {error ? <span className="entry-status vault-error" role="alert">{t('signIn.error')}</span> : null}
      </span>
      {!editing ? (
        <span className="workspace-actions">
          {view.status !== 'unrecognized' && view.status !== 'ambiguous' ? (
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              {t(view.status === 'recognized' ? 'signIn.edit' : 'signIn.add')}
            </Button>
          ) : null}
          {view.status !== 'absent' ? (
            <Button variant="danger" loading={busy} onClick={() => void save(null)}>{t('signIn.remove')}</Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
