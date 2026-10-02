import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';

export interface ShareSaveView {
  readonly id: string;
  readonly title: string;
  readonly entryType: 'key' | 'credential' | 'script' | 'creditCard';
  readonly vaults: readonly { id: string; name: string }[];
}

export interface ShareSaveClient {
  get(): Promise<ShareSaveView | null>;
  confirm(pendingId: string, vaultId: string): Promise<boolean>;
  cancel(pendingId: string): Promise<void>;
}

export const browserShareSaveClient: ShareSaveClient = {
  async get() {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'share-save/get' });
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true
      || !('pending' in response)) return null;
    return response.pending as ShareSaveView | null;
  },
  async confirm(pendingId, vaultId) {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'share-save/confirm', pendingId, vaultId });
    return !!response && typeof response === 'object' && 'status' in response && response.status === 'saved';
  },
  async cancel(pendingId) { await chrome.runtime.sendMessage({ type: 'share-save/cancel', pendingId }); },
};

export function usePendingShareSave(revision: number, client: ShareSaveClient = browserShareSaveClient): ShareSaveView | null {
  const [pending, setPending] = useState<ShareSaveView | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void client.get().then(value => { if (alive) setPending(value); }).catch(() => undefined); };
    refresh();
    return () => { alive = false; };
  }, [client, revision]);
  return pending;
}

export function ShareSavePrompt({ pending, onDone, client = browserShareSaveClient }:
  { pending: ShareSaveView; onDone(): void; client?: ShareSaveClient }): React.JSX.Element {
  const { t } = useI18n();
  const [vaultId, setVaultId] = useState(pending.vaults[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setBusy(true); setError(false);
    try { if (await client.confirm(pending.id, vaultId)) setSaved(true); else setError(true); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <section className="share-save-prompt" aria-labelledby="share-save-title">
    <h2 id="share-save-title">{t(saved ? 'shareSave.saved' : 'shareSave.title')}</h2>
    <p className="share-save-name">{pending.title}</p>
    <p className="share-save-kind">{t(`shareSave.type.${pending.entryType}`)}</p>
    {!saved ? <>
      <label className="field-label" htmlFor="share-save-vault">{t('shareSave.vault')}</label>
      <select id="share-save-vault" className="field-input entry-form-select" value={vaultId}
        onChange={event => setVaultId(event.target.value)} disabled={busy}>
        {pending.vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
      </select>
      {error ? <p role="alert" className="share-save-error">{t('shareSave.failed')}</p> : null}
      <div className="share-save-actions">
        <Button variant="subtle" disabled={busy} onClick={() => { void client.cancel(pending.id).then(onDone).catch(onDone); }}>
          {t('shareSave.cancel')}
        </Button>
        <Button disabled={!vaultId} loading={busy} onClick={() => { void save(); }}>{t('shareSave.confirm')}</Button>
      </div>
    </> : <Button block onClick={onDone}>{t('shareSave.done')}</Button>}
  </section>;
}
