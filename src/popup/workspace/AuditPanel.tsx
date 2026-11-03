import { RelativeTime } from '../components/RelativeTime';
import { useWorkspaceListRevision } from './useWorkspaceListRevision';
import { EntryScopeHeader } from '../components/EntryScopeHeader';
import { FilterSelect } from '../components/FilterSelect';
import { RefreshButton } from '../components/RefreshButton';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { WorkspaceError } from './WorkspaceError';
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
      'vault.exported',
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
  'entry-share.protection-changed': 'audit.event.entry-share.protection-changed',
  'entry-share.expired': 'audit.event.entry-share.expired',
  'entry-share.ended': 'audit.event.entry-share.ended',
  'entry-share.source-access-removed': 'audit.event.entry-share.source-access-removed',
  'org.member-joined': 'audit.event.org.member-joined',
  'org.member-role-changed': 'audit.event.org.member-role-changed',
  'org.member-removed': 'audit.event.org.member-removed',
  'audit.export.requested': 'audit.event.audit.export.requested',

  'auth.login-failed': 'audit.event.loginFailed',
  'credential.accessed': 'audit.event.credentialAccessed',
  'credential.access-denied': 'audit.event.credentialAccessDenied',
  'grant.requested': 'audit.event.grantRequested',
  'grant.created': 'audit.event.grantCreated',
  'grant.approved': 'audit.event.grantApproved',
  'grant.denied': 'audit.event.grantDenied',
  'grant.revoked': 'audit.event.grantRevoked',
  'grant.consumed': 'audit.event.grantConsumed',
  'grant.expired': 'audit.event.grantExpired',
  'grant.superseded': 'audit.event.grantSuperseded',
  'agent.enrolled': 'audit.event.agentEnrolled',
  'agent.blocked': 'audit.event.agentBlocked',
  'agent.reactivated': 'audit.event.agentReactivated',
  'agent.deleted': 'audit.event.agentDeleted',
  'vault.created': 'audit.event.vaultCreated',
  'vault.updated': 'audit.event.vaultUpdated',
  'vault.deleted': 'audit.event.vaultDeleted',
  'vault.exported': 'audit.event.vaultExported',
  'entry.created': 'audit.event.entryCreated',
  'entry.updated': 'audit.event.entryUpdated',
  'entry.deleted': 'audit.event.entryDeleted',
  'apikey.created': 'audit.event.apikeyCreated',
  'apikey.activated': 'audit.event.apikeyActivated',
  'apikey.revoked': 'audit.event.apikeyRevoked',
  'apikey.deleted': 'audit.event.apikeyDeleted',
  'org.created': 'audit.event.orgCreated',
  'org.updated': 'audit.event.orgUpdated',
  'org.member-invited': 'audit.event.orgMemberInvited',
  'org.invitation-resent': 'audit.event.orgInvitationResent',
  'org.invitation-cancelled': 'audit.event.orgInvitationCancelled',
  'org.invitation-role-changed': 'audit.event.orgInvitationRoleChanged',
  'user.signed-up': 'audit.event.userSignedUp',
  'account.setup-completed': 'audit.event.accountSetupCompleted',
  'account.recovery-completed': 'audit.event.accountRecoveryCompleted',
  'entry-share.created': 'audit.shareCreated',
  'entry-share.delivered': 'audit.shareDelivered',
  'entry-share.confirmed': 'audit.shareConfirmed',
  'entry-share.revoked': 'audit.shareRevoked',
};
const shorten = (id: string) =>
  id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;

export interface AuditTarget { kind: "grant" | "share"; id: string; vaultId: string; entryId?: string | undefined }
export function matchesAuditTarget(item: AuditLogItem, target: AuditTarget): boolean {
  return item.vaultId === target.vaultId && item.metadata?.[target.kind === "grant" ? "grantId" : "shareId"] === target.id;
}

export function AuditPanel({
  client,
  entries,
  entryId,
  vaultId,
  onBack,
  target, preview = false, onViewAll,
}: {
  target?: AuditTarget | undefined;
  preview?: boolean;
  onViewAll?: (() => void) | undefined;
  client: WorkspaceClient;
  entries: readonly EntryMetadata[];
  entryId?: string | undefined;
  vaultId?: string | undefined;
  onBack?: (() => void) | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const listRevision = useWorkspaceListRevision(client, 'workspace/audit');
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [members, setMembers] = useState<MemberIdentity[]>([]);
  const [cursor, setCursor] = useState<Record<string, string> | null>(null);
  const [filter, setFilter] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const revision = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [pageError, setPageError] = useState(false);
  useEffect(
    () => () => {
      revision.current++;
    },
    [client],
  );
  async function load(next?: Record<string, string>) {
    if (next && inFlight.current) return;
    inFlight.current = true;
    setPageError(false);
    const run = ++revision.current;
    setBusy(true);
    setError(false);
    try {
      const keys = next ? Object.keys(next) : filter.length ? filter : [''];
      const pages = await Promise.all(keys.map(async key => ({ key, page: await client.send({
        type: 'workspace/audit',
        ...(key ? { eventType: key } : {}),
        ...(entryId ? { entryId } : {}),
        ...(vaultId ? { vaultId } : {}),
        ...(next?.[key] ? { cursor: next[key] } : {}),
      }) })));
      const page = { items: pages.flatMap(result => result.page.items).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)) };
      const nextCursors = Object.fromEntries(pages.flatMap(result => result.page.nextCursor ? [[result.key, result.page.nextCursor]] : []));

      const identities = await client.members(
        page.items.flatMap((item) => (item.userId ? [item.userId] : [])),
      );
      if (revision.current !== run) return;
      setMembers(identities);
      setItems(previous => (next
        ? [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))]
        : page.items).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)));
      setCursor(Object.keys(nextCursors).length ? nextCursors : null);
    } catch (error) {
      if (revision.current === run) { setError(error); setPageError(Boolean(next)); }
    } finally {
      if (revision.current === run) { setBusy(false); inFlight.current = false; }
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    return () => {
      revision.current++;
    };
  }, [client, entryId, vaultId, filter, target?.id, target?.kind]);
  useEffect(() => { void load(); }, [client, entryId, vaultId, filter, listRevision, target?.id, target?.kind]);
  const scoped = target !== undefined;
  useEffect(() => {
    if (preview || scoped) return;
    const target = sentinel.current;
    if (!target || !cursor || busy || pageError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) void load(cursor);
    }, { root: target.closest('.audit-panel'), rootMargin: '120px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, busy, pageError, preview, scoped]);
  const visibleItems = target ? items.filter(item => matchesAuditTarget(item, target)) : items;
  return (
    <section
      className={`workspace-panel audit-panel${preview ? " audit-preview" : ""}`}
      aria-label={t('workspace.logs')}
    >
      <div className="workspace-toolbar">
        {preview ? <h3>{t("audit.recent")}</h3> : <>
        {entryId || target ? <EntryScopeHeader entry={entries.find(entry => entry.id === entryId && entry.vaultId === vaultId)} onBack={onBack} /> : (<FilterSelect multiple
          aria-label={t('audit.filter')}
          value={filter}
          onValueChange={setFilter}
        >
          <option value="">{t('workspace.all')}</option>
          {Object.entries(eventKeys).map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </FilterSelect>)}
        <RefreshButton busy={busy} onClick={() => { client.invalidate?.(['workspace/audit'], false); void load(); }} />
        </>}
      </div>
      {!preview && target ? <p className="audit-context-label">{t(target.kind === 'grant' ? 'audit.scopeGrant' : 'audit.scopeShare')} · {shorten(target.id)}</p> : null}
      {error ? <WorkspaceError error={error} /> : null}
      {busy && !items.length ? (
        <LoadingSkeleton />
      ) : null}
      {!busy && !error && !visibleItems.length ? (
        <p className="workspace-empty">{t(cursor && target ? 'audit.moreHistory' : 'audit.empty')}</p>
      ) : null}
      <div className="audit-list">
        {(preview ? visibleItems.slice(0, 10) : visibleItems).map((item) => {
          const entry = entries.find(
            (entry) =>
              entry.id === item.entryId &&
              (!item.vaultId || entry.vaultId === item.vaultId),
          );
          const actor = item.userId
            ? (members.find((member) => member.userId === item.userId)
                ?.displayName ?? item.actorName ?? shorten(item.userId))
            : item.agentId
              ? (item.agentName ?? shorten(item.agentId))
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
                <PopupIcon name={item.eventType.startsWith('grant.') ? (item.eventType === 'grant.requested' ? 'pending' : item.eventType === 'grant.approved' ? 'check' : 'lock') : item.eventType.startsWith('agent.') ? 'agent' : item.eventType.startsWith('vault.') ? 'vault' : item.eventType.startsWith('entry-share.') ? 'share' : item.eventType.startsWith('entry.') ? 'key' : 'logs'} />
              </span>
              <div className="audit-event-content">
                <div className="audit-primary"><p>
                  <strong>{actor}</strong> ·{' '}
                  {eventKeys[item.eventType]
                    ? t(eventKeys[item.eventType]!)
                    : t('audit.unknownEvent', { event: item.eventType })}
                </p>
                <RelativeTime value={item.createdAt} /></div>
                <div className="audit-chips" hidden={preview}>
                  <span className="audit-type">{eventKeys[item.eventType] ? t(eventKeys[item.eventType]!) : t('audit.unknownEvent', { event: item.eventType })}</span>
                  {entry ? (
                    <span><PopupIcon name="key" />{entry.name}</span>
                  ) : item.entryId ? (
                    <span>{shorten(item.entryId)}</span>
                  ) : null}
                  {item.vaultId ? (
                    <span><PopupIcon name="vault" />
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
      {preview && (visibleItems.length > 10 || cursor) ? <div className="audit-preview-footer"><button type="button" className="audit-more-link" onClick={onViewAll}>{t("audit.viewAll")}</button></div> : null}
      {cursor && !preview ? <div ref={sentinel} className="audit-sentinel">{busy ? <LoadingSkeleton /> : pageError ? <Button onClick={() => void load(cursor)}>{t('vault.retry')}</Button> : target ? <Button variant="subtle" onClick={() => void load(cursor)}>{t('workspace.more')}</Button> : null}</div> : null}
    </section>
  );
}
