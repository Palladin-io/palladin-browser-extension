import { useEffect, useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { EntryShareListItem } from '../../shared/workspace/contracts';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { SharingPanel } from './SharingPanel';
import { WorkspaceError } from './WorkspaceError';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { EntryIcon } from '../components/EntryIcon';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';

interface SharedEntry { entry: EntryMetadata; shares: EntryShareListItem[] }
export function SharingOverview({ client, vaultClient, entries }: {
  client: WorkspaceClient; vaultClient: VaultClient; entries: readonly EntryMetadata[];
}) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<EntryMetadata | null>(null);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let index = 0;
    setRows([]); setLoading(true); setError(null);
    async function work() {
      while (active && index < entries.length) {
        const entry = entries[index++]!;
        try {
          const shares: EntryShareListItem[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.send({ type: 'workspace/shares', vaultId: entry.vaultId, entryId: entry.id, ...(cursor ? { cursor } : {}) });
            if (!active) return;
            shares.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor && active);
          if (active && shares.length) setRows(current => [...current, { entry, shares }]);
        } catch (error) { if (active) setError(error); }
      }
    }
    void Promise.all([work(), work(), work()]).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, entries, revision]);
  if (selected || creating) return <SharingPanel client={client} vaultClient={vaultClient} entries={entries}
    {...(selected ? { initialEntry: selected } : {})} initialCreate={creating}
    onClose={() => { setSelected(null); setCreating(false); setRevision(value => value + 1); }} />;
  return <section className="workspace-panel sharing-panel" aria-label={t('workspace.shares')}>
    <div className="workspace-heading"><div><h2>{t('workspace.shares')}</h2><p>{t('share.existing')}</p></div>
      <Button variant="subtle" onClick={() => setRevision(value => value + 1)} disabled={loading}>{t('workspace.refresh')}</Button>
      <Button onClick={() => setCreating(true)}>{t('share.create')}</Button>
    </div>
    {error ? <WorkspaceError error={error} /> : null}
    {loading ? <LoadingSkeleton /> : null}
    {!loading && !error && !rows.length ? <p className="workspace-empty">{t('share.empty')}</p> : null}
    {rows.flatMap(({ entry, shares }) => shares.map(share => <button className="shared-entry-row" key={share.shareId} aria-label={`${entry.name} · ${entry.vaultName}`} onClick={() => setSelected(entry)}>
      <EntryIcon name={entry.name} type={entry.type} {...(entry.icon ? { icon: entry.icon } : {})} />
      <span><strong>{entry.name}</strong><small>{entry.vaultName} · {share.recipientEmail ?? t('share.anyone')}</small></span>
      <span>{t('share.expires', { date: new Date(share.expiresAt).toLocaleDateString(locale) })}</span>
    </button>))}
  </section>;
}
