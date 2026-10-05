import { SharingPanel } from '../workspace/SharingPanel';
import { EntryFields } from '../workspace/EntryFields';
import type { WorkspaceClient } from '../workspace/client';
import { useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { VaultClient } from '../vault/client';
import { useI18n } from '../i18n';
import { configuredPanelUrl } from '@shared/config/web-app';
import { fillMessage } from '../vault/messages';
import { EntryIcon } from './EntryIcon';
import { Button } from './Button';
import { PopupIcon } from './PopupIcon';

export function EntryDetail({
  entry,
  client,
  onBack,
  workspaceClient,
  onGrants,
  onLogs,
}: {
  entry: EntryMetadata;
  workspaceClient: WorkspaceClient;
  onGrants(): void;
  onLogs(): void;
  client: VaultClient;
  onBack(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function fill() {
    setBusy(true);
    try {
      setMessage(
        fillMessage(
          await (entry.type === 3
            ? client.fill(entry.vaultId, entry.id)
            : client.login(entry.vaultId, entry.id)),
          t,
        ),
      );
    } catch {
      setMessage(t('fill.error'));
    } finally {
      setBusy(false);
    }
  }
  const identity = <>
        {sharing ? <button className="toolbar-icon" aria-label={t('common.back')} title={t('common.back')} onClick={() => setSharing(false)}><PopupIcon name="back" /></button> : null}
        <EntryIcon
          name={entry.name}
          type={entry.type}
          {...(entry.icon ? { icon: entry.icon } : {})}
          {...(entry.color ? { color: entry.color } : {})}
        />
        <div className="detail-identity">
          <h2>{entry.name}</h2>
          <p>{entry.vaultName}</p>
        </div>
  </>;
  return (
    <section className="entry-detail" aria-label={t('detail.title')}>
      <button className="link-btn detail-back" onClick={onBack}>
        <PopupIcon name="back" />
        {t('common.back')}
      </button>
      {!sharing ? <div className="detail-heading">
        {identity}
        {(entry.type === 1 && entry.urlDomain) || entry.type === 3 ? (
          <Button loading={busy} onClick={() => void fill()}>
            {t(entry.type === 3 ? 'common.fill' : 'vault.logIn')}
          </Button>
        ) : null}
        <button className="toolbar-icon" aria-label={t('share.action')} title={t('share.action')} onClick={() => setSharing(true)}><PopupIcon name="share" /></button>
      </div> : null}
      {sharing ? <SharingPanel client={workspaceClient} vaultClient={client} entries={[entry]} initialEntry={entry} initialCreate embedded heading={identity} onClose={() => setSharing(false)} /> : null}
      <div hidden={sharing}>
      <EntryFields
        client={workspaceClient}
        vaultClient={client}
        vaultId={entry.vaultId}
        entryId={entry.id}
      />
      <div className="detail-navigation">
      <button className="detail-link" onClick={onGrants}>
        <PopupIcon name="agent" />
        {t('workspace.grants')}
        <PopupIcon name="chevron" />
      </button>
      <button className="detail-link" onClick={() => setSharing(true)}>
        <PopupIcon name="share" />
        {t('share.action')}
        <PopupIcon name="chevron" />
      </button>
      <button className="detail-link" onClick={onLogs}>
        <PopupIcon name="logs" />
        {t('workspace.logs')}
        <PopupIcon name="chevron" />
      </button>
      <button
        className="detail-link"
        onClick={() =>
          void configuredPanelUrl(`/vaults/${encodeURIComponent(entry.vaultId)}/entries/${encodeURIComponent(entry.id)}`)
            .then(url => chrome.tabs.create({ url })).catch(() => {})
        }
      >
        <PopupIcon name="edit" />
        {t('detail.edit')}
        <PopupIcon name="chevron" />
      </button>
      </div>
      </div>
      {message ? (
        <p role="status" className="entry-status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
