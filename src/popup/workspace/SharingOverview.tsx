import { AuditPanel, type AuditTarget } from './AuditPanel';
import { RelativeTime } from '../components/RelativeTime';
import { useWorkspaceListRevision } from './useWorkspaceListRevision';
import { EntryScopeHeader } from '../components/EntryScopeHeader';
import { FilterSelect } from '../components/FilterSelect';
import { PopupIcon } from '../components/PopupIcon';
import { RefreshButton } from '../components/RefreshButton';
import { useEffect, useRef, useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { WorkspaceResults } from '../../shared/workspace/commands';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { SharingPanel, shareStates } from './SharingPanel';
import { WorkspaceError } from './WorkspaceError';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { EntryIcon } from '../components/EntryIcon';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';

type SharedEntry = WorkspaceResults['workspace/my-shares']['items'][number];
export function SharingOverview({ client, vaultClient, entries, scope, onBack, onShowLogs }: {
  client: WorkspaceClient; vaultClient: VaultClient; entries: readonly EntryMetadata[];
  onShowLogs?: ((target: AuditTarget) => void) | undefined;
  scope?: { id: string; vaultId: string } | null | undefined;
  onBack?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const listRevision = useWorkspaceListRevision(client, scope ? 'workspace/shares' : 'workspace/my-shares');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string[]>([]);
  const [rows, setRows] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<EntryMetadata | null>(null);
  const [editing, setEditing] = useState<SharedEntry['share'] | null>(null);
  const [revoking, setRevoking] = useState<SharedEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const lifetime = useRef(0);
  const inFlight = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  async function load(next?: string) {
    if (inFlight.current) return;
    const run = ++generation.current;
    inFlight.current = true;
    setLoading(true); setError(null);
    try {
      const page = scope ? await client.send({ type: 'workspace/shares', vaultId: scope.vaultId, entryId: scope.id, ...(next ? { cursor: next } : {}) }).then(page => ({ ...page, items: page.items.map(share => ({ vaultId: scope.vaultId, entryId: scope.id, share })) })) : await client.send({ type: 'workspace/my-shares', ...(next ? { cursor: next } : {}) });
      if (run !== generation.current) return;
      setRows(current => next ? [...current, ...page.items.filter(item => !current.some(row => row.share.shareId === item.share.shareId))] : page.items);
      setCursor(page.nextCursor);
    } catch (error) { if (run === generation.current) setError(error); }
    finally { if (run === generation.current) { inFlight.current = false; setLoading(false); } }
  }
  async function revoke() {
    if (!revoking || busy) return;
    const run = lifetime.current;
    setBusy(true); setError(null);
    try {
      await client.send({ type: 'workspace/revoke-share', vaultId: revoking.vaultId, entryId: revoking.entryId, shareId: revoking.share.shareId });
      if (run !== lifetime.current) return;
      setRows(current => current.map(row => row.share.shareId === revoking.share.shareId ? { ...row, share: { ...row.share, status: 'revoked' } } : row));
      setRevoking(null);
    } catch (error) { if (run === lifetime.current) setError(error); }
    finally { if (run === lifetime.current) setBusy(false); }
  }
  useEffect(() => {
    inFlight.current = false;
    setBusy(false); setRevoking(null);
    setRows([]); setCursor(null); setFocusedId(null); setSelected(null); setEditing(null);
    return () => { generation.current++; lifetime.current++; };
  }, [client, scope?.id, scope?.vaultId]);
  useEffect(() => { inFlight.current = false; void load(); }, [client, scope?.id, scope?.vaultId, listRevision]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor || loading || error || selected || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) void load(cursor);
    }, { root: target.closest('.grant-list'), rootMargin: '120px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, loading, error, selected]);
  if (selected) return <SharingPanel client={client} vaultClient={vaultClient} entries={entries}
    {...(selected ? { initialEntry: selected } : {})} initialProtectionShare={editing ?? undefined}
    onClose={() => { setSelected(null); setEditing(null); void load(); }} />;
  const focused = rows.find(row => row.share.shareId === focusedId && (!status.length || status.includes(row.share.status)));
  const focusedEntry = focused ? entries.find(entry => entry.id === focused.entryId && entry.vaultId === focused.vaultId) : undefined;
  return <section className="workspace-panel sharing-panel sharing-overview" aria-label={t('workspace.shares')}>
    <div className="grants-layout"><div className="grant-sidebar">
    <div className="grant-list-controls">
      {scope ? <EntryScopeHeader entry={entries.find(entry => entry.id === scope.id && entry.vaultId === scope.vaultId)} onBack={onBack} /> : (<FilterSelect multiple aria-label={t('share.filterLoaded')} value={status} onValueChange={setStatus}>
        <option value="">{t('share.all')}</option>
        {Object.entries(shareStates).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </FilterSelect>)}
      <RefreshButton busy={loading || busy} onClick={() => { client.invalidate?.(['workspace/shares', 'workspace/my-shares'], false); void load(); }} />
    </div>
    <div className="grant-list">
    {error ? <WorkspaceError error={error} /> : null}
    {loading && !rows.length ? <LoadingSkeleton /> : null}
    {!loading && !error && !rows.some(row => !status.length || status.includes(row.share.status)) ? <p className="workspace-empty">{t('share.empty')}</p> : null}
    {rows.filter(row => !status.length || status.includes(row.share.status)).sort((a, b) => Number(b.share.status === 'active') - Number(a.share.status === 'active') || Date.parse(b.share.createdAt) - Date.parse(a.share.createdAt) || b.share.shareId.localeCompare(a.share.shareId)).map(({ vaultId, entryId, share }) => {
      const entry = entries.find(entry => entry.id === entryId && entry.vaultId === vaultId);
      const name = entry?.name ?? t('share.unavailableEntry');
      return <div className="shared-entry-management" key={share.shareId}><div className="shared-entry-summary"><button className="shared-entry-row grant-row" aria-pressed={focusedId === share.shareId} disabled={busy} aria-label={entry ? `${name} · ${entry.vaultName}` : name} onClick={() => setFocusedId(share.shareId)}>
        <EntryIcon name={name} type={entry?.type ?? 1} {...(entry?.icon ? { icon: entry.icon } : {})} />
        <span className="grant-row-content"><strong title={name}>{name}</strong>
          <span className="grant-list-resource"><small title={share.recipientEmail ?? t('share.anyone')}>{share.recipientEmail ?? t('share.anyone')}</small>
            <span className="grant-status" data-status={share.status}>{t(shareStates[share.status] ?? 'share.unknownStatus')}</span>
          </span>
        </span>
      </button>
      </div>
      </div>;
    })}
    {status.length > 0 && cursor ? <p className="share-hint">{t('share.filterLoadedHint')}</p> : null}
    {cursor ? <div ref={sentinel} className="audit-sentinel">{loading && rows.length > 0 ? <LoadingSkeleton /> : error ? <Button onClick={() => void load(cursor)}>{t('vault.retry')}</Button> : <Button variant="subtle" onClick={() => void load(cursor)}>{t('workspace.more')}</Button>}</div> : null}
    </div></div>
    {focused ? <div className="entry-detail grant-detail share-overview-detail">
      <div className="detail-heading share-identity-card">
        <EntryIcon name={focusedEntry?.name ?? t('share.unavailableEntry')} type={focusedEntry?.type ?? 1} {...(focusedEntry?.icon ? { icon: focusedEntry.icon } : {})} />
        <div className="detail-identity"><h2 title={focusedEntry?.name ?? t('share.unavailableEntry')}>{focusedEntry?.name ?? t('share.unavailableEntry')}</h2><p>{focusedEntry?.vaultName}</p></div>
        <span className="grant-status" data-status={focused.share.status}>{t(shareStates[focused.share.status] ?? 'share.unknownStatus')}</span>
      </div>
      <dl className="grant-metadata">
        <div className="detail-field"><dt>{t('share.recipient')}</dt><dd>{focused.share.recipientEmail ?? t('share.anyone')}</dd></div>
        <div className="detail-field"><dt>{t('share.createdAt')}</dt><dd><RelativeTime value={focused.share.createdAt} /></dd></div>
        <div className="detail-field"><dt>{t('grant.expiresAt')}</dt><dd>{focused.share.expiresAt ? <RelativeTime value={focused.share.expiresAt} /> : t('grant.noExpiry')}</dd></div>
        <div className="detail-field"><dt>{t("share.sharedBy")}</dt><dd>{t("share.you")}</dd></div>
      </dl>
      <div className="share-management-card"><div className="workspace-actions share-detail-actions">
        {focusedEntry && focused.share.status === 'active' && ['none', 'password', 'pin'].includes(focused.share.protection) ? <Button variant="subtle" disabled={busy} onClick={() => { setEditing(focused.share); setSelected(focusedEntry); }}><PopupIcon name="edit" />{t('share.changeProtection')}</Button> : null}
        {['active', 'locked', 'suspended', 'consumed'].includes(focused.share.status) ? <Button variant="danger" disabled={busy} onClick={() => setRevoking(focused)}><PopupIcon name="denied" />{t('share.revoke')}</Button> : null}
      {focusedEntry ? <Button variant="subtle" disabled={busy} title={t('share.entryLinks')} onClick={() => setSelected(focusedEntry)}>{t('share.allLinks')}</Button> : null}
      </div>
      {revoking?.share.shareId === focused.share.shareId ? <div className="share-revoke-confirm"><p>{t('share.revokeNotice')}</p><div className="workspace-actions">
        <Button variant="subtle" disabled={busy} onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
        <Button variant="danger" loading={busy} onClick={() => void revoke()}>{t('share.revoke')}</Button>
      </div></div> : null}

      </div>
      {onShowLogs ? <AuditPanel client={client} entries={entries} vaultId={focused.vaultId} entryId={focused.entryId}
        target={{ kind: 'share', id: focused.share.shareId, vaultId: focused.vaultId, entryId: focused.entryId }} preview
        onViewAll={() => onShowLogs?.({ kind: 'share', id: focused.share.shareId, vaultId: focused.vaultId, entryId: focused.entryId })} /> : null}
    </div> : <div className="detail-empty">{t('share.select')}</div>}
    </div>
  </section>;
}
