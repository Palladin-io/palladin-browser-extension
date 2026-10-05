import { RefreshButton } from '../components/RefreshButton';
import { useEffect, useRef, useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { WorkspaceResults } from '../../shared/workspace/commands';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { SharingPanel } from './SharingPanel';
import { WorkspaceError } from './WorkspaceError';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { EntryIcon } from '../components/EntryIcon';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';

type SharedEntry = WorkspaceResults['workspace/my-shares']['items'][number];
export function SharingOverview({ client, vaultClient, entries }: {
  client: WorkspaceClient; vaultClient: VaultClient; entries: readonly EntryMetadata[];
}) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<EntryMetadata | null>(null);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  async function load(next?: string) {
    if (inFlight.current) return;
    const run = ++generation.current;
    inFlight.current = true;
    setLoading(true); setError(null);
    try {
      const page = await client.send({ type: 'workspace/my-shares', ...(next ? { cursor: next } : {}) });
      if (run !== generation.current) return;
      setRows(current => next ? [...current, ...page.items.filter(item => !current.some(row => row.share.shareId === item.share.shareId))] : page.items);
      setCursor(page.nextCursor);
    } catch (error) { if (run === generation.current) setError(error); }
    finally { if (run === generation.current) { inFlight.current = false; setLoading(false); } }
  }
  useEffect(() => {
    inFlight.current = false;
    setRows([]); setCursor(null);
    void load();
    return () => { generation.current++; };
  }, [client]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor || loading || error || selected || creating || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) void load(cursor);
    }, { root: target.closest('.sharing-panel'), rootMargin: '120px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, loading, error, selected, creating]);
  if (selected || creating) return <SharingPanel client={client} vaultClient={vaultClient} entries={entries}
    {...(selected ? { initialEntry: selected } : {})} initialCreate={creating}
    onClose={() => { setSelected(null); setCreating(false); void load(); }} />;
  return <section className="workspace-panel sharing-panel" aria-label={t('workspace.shares')}>
    <div className="workspace-heading"><div><h2>{t('workspace.shares')}</h2><p>{t('share.existing')}</p></div>
      <RefreshButton busy={loading} onClick={() => void load()} />
      <Button onClick={() => setCreating(true)}>{t('share.create')}</Button>
    </div>
    {error ? <WorkspaceError error={error} /> : null}
    {loading && !rows.length ? <LoadingSkeleton /> : null}
    {!loading && !error && !rows.length ? <p className="workspace-empty">{t('share.empty')}</p> : null}
    {rows.map(({ vaultId, entryId, share }) => {
      const entry = entries.find(entry => entry.id === entryId && entry.vaultId === vaultId);
      const name = entry?.name ?? t('share.unavailableEntry');
      return <button className="shared-entry-row" key={share.shareId} disabled={!entry} aria-label={entry ? `${name} · ${entry.vaultName}` : name} onClick={() => entry && setSelected(entry)}>
        <EntryIcon name={name} type={entry?.type ?? 1} {...(entry?.icon ? { icon: entry.icon } : {})} />
        <span><strong>{name}</strong><small>{entry?.vaultName ? `${entry.vaultName} · ` : ''}{share.recipientEmail ?? t('share.anyone')}</small></span>
        <span>{t('share.expires', { date: new Date(share.expiresAt).toLocaleDateString(locale) })}</span>
      </button>;
    })}
    {cursor ? <div ref={sentinel} className="audit-sentinel">{loading && rows.length > 0 ? <LoadingSkeleton /> : error ? <Button onClick={() => void load(cursor)}>{t('vault.retry')}</Button> : null}</div> : null}
  </section>;
}
