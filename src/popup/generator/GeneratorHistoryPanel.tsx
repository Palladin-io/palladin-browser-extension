import { useEffect, useRef, useState } from 'react';
import type { HistoryItem } from '../../background/generator/history';
import { clipboardCopyAvailable } from '@shared/config/build-target';
import { Button } from '../components/Button';
import { useI18n } from '../i18n';
import type { VaultClient } from '../vault/client';
import { historyCommand } from './history-client';

export function GeneratorHistoryPanel({ client }: { client: VaultClient }): React.JSX.Element {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'copied'>('loading');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void historyCommand({ type: 'generator-history/list' }).then(result => {
      if (mounted.current) { setItems(result.items ?? []); setStatus('ready'); }
    }, () => { if (mounted.current) setStatus('error'); });
    return () => { mounted.current = false; };
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await action(); }
    catch { if (mounted.current) setStatus('error'); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function reveal(item: HistoryItem, copy: boolean): Promise<void> {
    const result = await historyCommand({ type: 'generator-history/reveal', id: item.id });
    if (!mounted.current || result.value === undefined) return;
    if (copy) {
      await navigator.clipboard.writeText(result.value);
      await client.armClipboardClear();
      if (mounted.current) setStatus('copied');
    } else setRevealed({ id: item.id, value: result.value });
  }

  return <section className="generator" aria-label={t('history.title')}>
    <p className="generator-note">{t('history.note')}</p>
    <p role="status">{status === 'error' ? t('history.error') : status === 'loading' ? t('history.loading')
      : status === 'copied' ? t('generator.copied') : items.length === 0 ? t('history.empty') : ''}</p>
    {items.map(item => <article className="capture-prompt" key={item.id}>
      <strong>{item.origin ? new URL(item.origin).hostname : t('history.noSite')}</strong>
      <p>{new Date(item.createdAt).toLocaleString(locale)}</p>
      <output className="generator-output">{revealed?.id === item.id ? revealed.value : '••••••••'}</output>
      <div className="generator-actions">
        <Button variant="subtle" disabled={busy} onClick={() => {
          if (revealed?.id === item.id) setRevealed(null);
          else void run(() => reveal(item, false));
        }}>{revealed?.id === item.id ? t('history.hide') : t('history.reveal')}</Button>
        {clipboardCopyAvailable && <Button variant="subtle" disabled={busy} onClick={() => void run(() => reveal(item, true))}>{t('common.copy')}</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
          await historyCommand({ type: 'generator-history/remove', id: item.id });
          if (mounted.current) { setItems(previous => previous.filter(row => row.id !== item.id)); setRevealed(null); }
        })}>{t('history.delete')}</Button>
      </div>
    </article>)}
    {confirmClear ? <div className="generator-actions">
      <p>{t('history.confirmClear')}</p>
      <Button variant="danger" loading={busy} onClick={() => void run(async () => {
        await historyCommand({ type: 'generator-history/clear' });
        if (mounted.current) { setItems([]); setRevealed(null); setConfirmClear(false); setStatus('ready'); }
      })}>{t('history.clear')}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>{t('history.cancel')}</Button>
    </div> : <Button variant="ghost" disabled={busy || status === 'loading'} onClick={() => setConfirmClear(true)}>{t('history.clear')}</Button>}
  </section>;
}
