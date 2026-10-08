import { useEffect, useRef, useState } from 'react';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { PopupIcon } from '../components/PopupIcon';
import { useI18n } from '../i18n';

export function EntryTotpField({ client, vaultClient, vaultId, entryId, fieldId, label }: {
  client: WorkspaceClient; vaultClient: VaultClient; vaultId: string; entryId: string; fieldId: string; label: string;
}) {
  const { t } = useI18n();
  const activeScope = useRef<object | null>(null);
  const [code, setCode] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const scope = {};
    activeScope.current = scope;
    setCode('');
    setFailed(false);
    setCopied(false);
    let active = true, pending = false, deadline = 0, retryAt = 0;
    async function tick() {
      if (!active) return;
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds > 0 || pending || Date.now() < retryAt) return;
      pending = true;
      setCode('');
      try {
        const result = await client.send({ type: 'workspace/field', vaultId, entryId, fieldId });
        if (!active) return;
        deadline = Date.now() + (result.expiresIn ?? 1) * 1000;
        setCode(result.value); setRemaining(result.expiresIn ?? 1); setFailed(false);
      } catch { if (active) { setFailed(true); retryAt = Date.now() + 10_000; } }
      finally { pending = false; }
    }
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => { active = false; activeScope.current = null; clearInterval(timer); };
  }, [client, vaultId, entryId, fieldId]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    const scope = activeScope.current;
    try {
      const result = await client.send({ type: 'workspace/field', vaultId, entryId, fieldId });
      if (!scope || activeScope.current !== scope) return;
      await navigator.clipboard.writeText(result.value);
      await vaultClient.armClipboardClear();
      if (activeScope.current === scope) setCopied(true);
    } catch { if (activeScope.current === scope) setFailed(true); }
  }
  const formatted = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return <div className="detail-field entry-totp">
    <span><small>{label || t('field.totp')}</small><span className="detail-field-value totp-code">{formatted || (failed ? t('common.failed') : '-')}</span></span>
    <div className="field-actions"><span className="totp-secs" aria-label={t('vault.secondsLeft', { count: remaining })}>{remaining}s</span>
      <button className="toolbar-icon" type="button" disabled={!code} aria-label={t(copied ? 'common.copied' : 'vault.copyCode')} onClick={() => void copy()}><PopupIcon name={copied ? 'check' : 'copy'} /></button>
    </div>
  </div>;
}
