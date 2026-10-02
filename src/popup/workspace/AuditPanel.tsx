import { useEffect, useRef, useState } from 'react';
import type {
  AuditLogItem,
  MemberIdentity,
} from '../../shared/workspace/contracts';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import { useI18n, type TranslationKey } from '../i18n';
import { Button } from '../components/Button';
import { PopupIcon } from '../components/PopupIcon';
import type { WorkspaceClient } from './client';

const tones: Record<string, string> = {
  'grant.requested': 'pending',
  ...Object.fromEntries(
    [
      'credential.accessed',
      'grant.created',
      'grant.approved',
      'agent.reactivated',
      'apikey.activated',
      'account.setup-completed',
      'account.recovery-completed',
      'entry-share.delivered',
      'entry-share.confirmed',
    ].map((type) => [type, 'success']),
  ),
  ...Object.fromEntries(
    [
      'agent.enrolled',
      'vault.created',
      'vault.updated',
      'entry.created',
      'entry.updated',
      'org.created',
      'org.updated',
      'org.member-invited',
      'org.invitation-resent',
      'org.invitation-role-changed',
      'user.signed-up',
      'apikey.created',
      'entry-share.created',
      'entry-share.protection-changed',
    ].map((type) => [type, 'info']),
  ),
  ...Object.fromEntries(
    [
      'auth.login-failed',
      'credential.access-denied',
      'grant.denied',
      'grant.revoked',
      'agent.blocked',
      'agent.deleted',
      'vault.deleted',
      'entry.deleted',
      'apikey.revoked',
      'apikey.deleted',
      'org.invitation-cancelled',
      'entry-share.revoked',
    ].map((type) => [type, 'danger']),
  ),
};
const eventKeys: Record<string, TranslationKey> = {
  'credential.accessed': 'audit.credentialAccessed',
  'credential.access-denied': 'audit.accessDenied',
  'grant.requested': 'audit.grantRequested',
  'grant.created': 'audit.grantCreated',
  'grant.approved': 'audit.grantApproved',
  'grant.denied': 'audit.grantDenied',
  'grant.revoked': 'audit.grantRevoked',
  'grant.expired': 'audit.grantExpired',
  'grant.consumed': 'audit.grantConsumed',
  'grant.superseded': 'audit.grantSuperseded',
  'entry.created': 'audit.entryCreated',
  'entry.updated': 'audit.entryUpdated',
  'entry.deleted': 'audit.entryDeleted',
  'agent.enrolled': 'audit.agentEnrolled',
  'agent.blocked': 'audit.agentBlocked',
  'entry-share.created': 'audit.shareCreated',
  'entry-share.delivered': 'audit.shareDelivered',
  'entry-share.confirmed': 'audit.shareConfirmed',
  'entry-share.revoked': 'audit.shareRevoked',
};
const shorten = (id: string) =>
  id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;

export function AuditPanel({
  client,
  entries,
  entryId,
  vaultId,
}: {
  client: WorkspaceClient;
  entries: readonly EntryMetadata[];
  entryId?: string | undefined;
  vaultId?: string | undefined;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [members, setMembers] = useState<MemberIdentity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current++;
    },
    [client],
  );
  async function load(next?: string) {
    const run = ++revision.current;
    setBusy(true);
    setError(false);
    try {
      const page = await client.send({
        type: 'workspace/audit',
        ...(entryId ? { entryId } : {}),
        ...(vaultId ? { vaultId } : {}),
        ...(filter ? { eventType: filter } : {}),
        ...(next ? { cursor: next } : {}),
      });
      const identities = await client.members(
        page.items.flatMap((item) => (item.userId ? [item.userId] : [])),
      );
      if (revision.current !== run) return;
      setMembers(identities);
      setItems((previous) =>
        next
          ? [
              ...previous,
              ...page.items.filter(
                (item) => !previous.some((row) => row.id === item.id),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
    } catch {
      if (revision.current === run) setError(true);
    } finally {
      if (revision.current === run) setBusy(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      revision.current++;
    };
  }, [client, entryId, vaultId, filter]);
  return (
    <section
      className="workspace-panel audit-panel"
      aria-label={t('workspace.logs')}
    >
      <div className="workspace-heading">
        <div>
          <h2>{t('workspace.logs')}</h2>
          <p>{t('audit.subtitle')}</p>
        </div>
        <select
          aria-label={t('audit.filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="">{t('workspace.all')}</option>
          {Object.entries(eventKeys).map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </select>
        <Button variant="subtle" disabled={busy} onClick={() => void load()}>
          {t('workspace.refresh')}
        </Button>
      </div>
      {error ? <p role="alert">{t('workspace.error')}</p> : null}
      {busy && !items.length ? (
        <p role="status">{t('workspace.loading')}</p>
      ) : null}
      {!busy && !error && !items.length ? (
        <p className="workspace-empty">{t('audit.empty')}</p>
      ) : null}
      <div className="audit-list">
        {items.map((item) => {
          const entry = entries.find(
            (entry) =>
              entry.id === item.entryId &&
              (!item.vaultId || entry.vaultId === item.vaultId),
          );
          const actor = item.userId
            ? (members.find((member) => member.userId === item.userId)
                ?.displayName ?? shorten(item.userId))
            : item.agentId
              ? shorten(item.agentId)
              : t(
                  item.actorType === 'system'
                    ? 'audit.system'
                    : item.actorType === 'externalRecipient'
                      ? 'audit.recipient'
                      : 'audit.unknownActor',
                );
          return (
            <article
              key={item.id}
              className="audit-event"
              data-tone={tones[item.eventType] ?? 'neutral'}
            >
              <span className="audit-icon">
                <PopupIcon name="logs" />
              </span>
              <div className="audit-event-content">
                <p>
                  <strong>{actor}</strong> ·{' '}
                  {eventKeys[item.eventType]
                    ? t(eventKeys[item.eventType]!)
                    : t('audit.unknownEvent', { event: item.eventType })}
                </p>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString(locale)}
                </time>
                <div className="audit-chips">
                  {entry ? (
                    <span>{entry.name}</span>
                  ) : item.entryId ? (
                    <span>{shorten(item.entryId)}</span>
                  ) : null}
                  {item.vaultId ? (
                    <span>
                      {entry?.vaultName ??
                        entries.find((entry) => entry.vaultId === item.vaultId)
                          ?.vaultName ??
                        shorten(item.vaultId)}
                    </span>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {cursor ? (
        <Button
          variant="subtle"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          {t('workspace.more')}
        </Button>
      ) : null}
    </section>
  );
}
