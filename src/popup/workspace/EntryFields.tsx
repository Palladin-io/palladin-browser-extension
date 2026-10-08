import { EntryTotpField } from './EntryTotpField';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { PopupIcon } from '../components/PopupIcon';
import { useEffect, useRef, useState } from 'react';
import type { EntryFieldView } from '../../shared/workspace/commands';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { useI18n, type TranslationKey } from '../i18n';

const labels: Record<string, TranslationKey> = {
  'credential.username': 'entry.username',
  'credential.password': 'entry.password',
  'credential.url': 'detail.website',
  'key.value': 'detail.key',
  'key.url': 'detail.website',
  'script.source': 'field.script',
  'script.interpreter': 'field.interpreter',
  'creditCard.cardholderName': 'field.cardholder',
  'creditCard.cardNumber': 'field.cardNumber',
  'creditCard.cvv': 'field.cvv',
  'creditCard.expiryMonth': 'field.expiryMonth',
  'creditCard.expiryYear': 'field.expiryYear',
  'creditCard.billingAddress': 'field.billing',
  description: 'field.description',
  notes: 'field.notes',
};
export function EntryFields({
  client,
  vaultClient,
  vaultId,
  entryId,
}: {
  client: WorkspaceClient;
  vaultClient: VaultClient;
  vaultId: string;
  entryId: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<EntryFieldView[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const active = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    active.current = true;
    void client
      .send({ type: 'workspace/detail', vaultId, entryId })
      .then((result) => {
        if (active.current) setFields(result.fields);
      })
      .catch(() => {
        if (active.current) setError(true);
      }).finally(() => { if (active.current) setLoading(false); });
    return () => {
      active.current = false;
      timers.current.forEach(clearTimeout);
    };
  }, [client, vaultId, entryId]);
  async function read(field: EntryFieldView, copy: boolean) {
    setBusy(field.id);
    setError(false);
    try {
      const result = await client.send({
        type: 'workspace/field',
        vaultId,
        entryId,
        fieldId: field.id,
      });
      if (!active.current) return;
      if (copy) {
        await navigator.clipboard.writeText(result.value);
        await vaultClient.armClipboardClear();
        if (active.current) {
          setCopied(field.id);
          timers.current.push(setTimeout(() => setCopied(null), 1500));
        }
      } else {
        setRevealed((previous) => ({ ...previous, [field.id]: result.value }));
        timers.current.push(
          setTimeout(
            () =>
              setRevealed((previous) => {
                const next = { ...previous };
                delete next[field.id];
                return next;
              }),
            20_000,
          ),
        );
      }
    } catch {
      if (active.current) setError(true);
    } finally {
      if (active.current) setBusy(null);
    }
  }
  return (
    <>
      {loading ? <LoadingSkeleton /> : null}
      <div className="detail-fields">
        {fields
          .map((field) => field.type === 'totp' ? <EntryTotpField key={field.id} client={client} vaultClient={vaultClient} vaultId={vaultId} entryId={entryId} fieldId={field.id} label={field.label} /> : (
            <div className="detail-field" key={field.id}>
              <span>
                <small>
                  {field.label ||
                    (labels[field.id]
                      ? t(labels[field.id]!)
                      : t('field.custom'))}
                </small>
                <span className="detail-field-value">
                  {revealed[field.id] ?? field.value ?? '••••••••••••'}
                </span>
              </span>
              <div className="field-actions">
                {field.value === null ? (
                  <button
                    className="toolbar-icon"
                    aria-label={t(revealed[field.id] ? "field.hide" : "field.show")}
                    title={t(revealed[field.id] ? "field.hide" : "field.show")}
                    disabled={busy !== null}
                    onClick={() =>
                      revealed[field.id]
                        ? setRevealed((previous) => {
                            const next = { ...previous };
                            delete next[field.id];
                            return next;
                          })
                        : void read(field, false)
                    }
                  >
                    <PopupIcon name={revealed[field.id] ? "eye-off" : "eye"} />
                  </button>
                ) : null}
                <button
                  className="toolbar-icon"
                  aria-label={
                    field.id === 'credential.password'
                      ? t('vault.copyPassword')
                      : field.id === 'credential.username'
                        ? t('vault.copyUsername')
                        : t("field.copy")
                  }
                  disabled={busy !== null}
                  onClick={() => void read(field, true)}
                >
                  <PopupIcon name={copied === field.id ? "check" : "copy"} /><span className="sr-only">{t(copied === field.id ? "common.copied" : "field.copy")}</span>
                </button>
              </div>
            </div>
          ))}
      </div>
      {error ? <p role="alert">{t('workspace.error')}</p> : null}
    </>
  );
}
