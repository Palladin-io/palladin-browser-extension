import { EntryFields } from '../workspace/EntryFields';
import type { WorkspaceClient } from '../workspace/client';
import { useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { VaultClient } from '../vault/client';
import { useI18n } from '../i18n';
import { entryDeepLink } from '@shared/config/web-app';
import { fillMessage } from '../vault/messages';
import { EntryIcon } from './EntryIcon';
import { TotpBadge } from './TotpBadge';
import { Button } from './Button';
import { PopupIcon } from './PopupIcon';

export function EntryDetail({
  entry,
  client,
  onBack,
  onShare,
  workspaceClient,
  onGrants,
  onLogs,
}: {
  entry: EntryMetadata;
  workspaceClient: WorkspaceClient;
  onGrants(): void;
  onLogs(): void;
  client: VaultClient;
  onShare(): void;
  onBack(): void;
}): React.JSX.Element {
  const { t } = useI18n();
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
  return (
    <section className="entry-detail" aria-label={t('detail.title')}>
      <button className="link-btn detail-back" onClick={onBack}>
        <PopupIcon name="back" />
        {t('common.back')}
      </button>
      <div className="detail-heading">
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
        {(entry.type === 1 && entry.urlDomain) || entry.type === 3 ? (
          <Button loading={busy} onClick={() => void fill()}>
            {t(entry.type === 3 ? 'common.fill' : 'vault.logIn')}
          </Button>
        ) : null}
        <Button variant="subtle" onClick={onShare}>
          {t('share.action')}
        </Button>
      </div>
      <EntryFields
        client={workspaceClient}
        vaultClient={client}
        vaultId={entry.vaultId}
        entryId={entry.id}
      />
      {entry.type === 1 ? (
        <TotpBadge client={client} vaultId={entry.vaultId} entryId={entry.id} />
      ) : null}
      <button className="detail-link" onClick={onGrants}>
        <PopupIcon name="agent" />
        {t('workspace.grants')}
        <PopupIcon name="chevron" />
      </button>
      <button className="detail-link" onClick={onShare}>
        <PopupIcon name="share" />
        {t('workspace.shares')}
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
          void chrome.tabs.create({
            url: entryDeepLink(entry.vaultId, entry.id),
          })
        }
      >
        <PopupIcon name="edit" />
        {t('detail.edit')}
        <PopupIcon name="chevron" />
      </button>
      {message ? (
        <p role="status" className="entry-status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
