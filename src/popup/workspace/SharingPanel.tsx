import {
  sharingRecipients,
  validShareProtection,
} from '../../shared/workspace/sharing-input';
import { useEffect, useRef, useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type {
  EntryShareListItem,
  ShareProtection,
} from '../../shared/workspace/contracts';
import type { WorkspaceCommand } from '../../shared/workspace/commands';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { useI18n } from '../i18n';
import { Button } from '../components/Button';

type CreateCommand = Extract<
  WorkspaceCommand,
  { type: 'workspace/create-share' }
>;
export function SharingPanel({
  client,
  vaultClient,
  entries,
  initialEntry,
}: {
  client: WorkspaceClient;
  vaultClient: VaultClient;
  entries: readonly EntryMetadata[];
  initialEntry?: EntryMetadata | undefined;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [entryKey, setEntryKey] = useState(
    initialEntry ? `${initialEntry.vaultId}:${initialEntry.id}` : '',
  );
  const entry = entries.find(
    (entry) => `${entry.vaultId}:${entry.id}` === entryKey,
  );
  const [items, setItems] = useState<EntryShareListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hours, setHours] = useState<1 | 24 | 72 | 168>(24);
  const [receipts, setReceipts] = useState('');
  const [named, setNamed] = useState(false);
  const [email, setEmail] = useState('');
  const [protection, setProtection] = useState<ShareProtection>('none');
  const [secret, setSecret] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [inputError, setInputError] = useState(false);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [links, setLinks] = useState<
    { url: string; email: string | null; operationId: string }[]
  >([]);
  const [attempt, setAttempt] = useState<CreateCommand[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const operations = useRef<string[]>([]);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      for (const operationId of operations.current)
        void client
          .send({ type: 'workspace/discard-share', operationId })
          .catch(() => undefined);
    };
  }, [client]);
  async function load(next?: string) {
    if (!entry) return;
    const revision = ++generation.current;
    setLoadingList(true);
    setError(false);
    try {
      const page = await client.send({
        type: 'workspace/shares',
        vaultId: entry.vaultId,
        entryId: entry.id,
        ...(next ? { cursor: next } : {}),
      });
      if (generation.current !== revision || !alive.current) return;
      setItems((previous) =>
        next
          ? [
              ...previous,
              ...page.items.filter(
                (row) => !previous.some((item) => item.shareId === row.shareId),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
    } catch {
      if (generation.current === revision && alive.current) setError(true);
    } finally { if (generation.current === revision && alive.current) setLoadingList(false); }
  }
  function reset() {
    for (const operationId of operations.current)
      void client
        .send({ type: 'workspace/discard-share', operationId })
        .catch(() => undefined);
    operations.current = [];
    setAttempt(null);
    setLinks([]);
    setSecret('');
    setConfirmation('');
    setInputError(false);
    setCopied(null);
    setChanging(null);
  }
  useEffect(() => {
    reset();
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [entryKey, client]);
  async function create() {
    if (!entry) return;
    setBusy(true);
    setError(false);
    try {
      const recipients = named ? sharingRecipients(email) : [null];
      if (
        !attempt &&
        (!recipients ||
          !validShareProtection(
            protection,
            protection === 'none' ? null : secret,
          ) ||
          (protection !== 'none' && secret !== confirmation))
      ) {
        setInputError(true);
        return;
      }
      setInputError(false);
      const commands: CreateCommand[] =
        attempt ??
        recipients!.map((recipientEmail) => ({
          type: 'workspace/create-share',
          operationId: crypto.randomUUID(),
          vaultId: entry.vaultId,
          entryId: entry.id,
          hours,
          maximumReceipts: receipts ? Number(receipts) : null,
          recipientEmail,
          protection,
          protectionSecret: protection === 'none' ? null : secret,
          notifyOnFirstReceipt: notify,
        }));
      operations.current = commands.map((command) => command.operationId);
      setAttempt(commands);
      for (const command of commands) {
        if (links.some((link) => link.operationId === command.operationId))
          continue;
        const result = await client.send(command);
        if (!alive.current) {
          void client
            .send({
              type: 'workspace/discard-share',
              operationId: command.operationId,
            })
            .catch(() => undefined);
          return;
        }
        setLinks((previous) => [
          ...previous,
          {
            url: result.url,
            email: command.recipientEmail,
            operationId: command.operationId,
          },
        ]);
      }
      setSecret('');
      setConfirmation('');
      await load();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function revoke(shareId: string) {
    if (!entry) return;
    setBusy(true);
    setError(false);
    try {
      await client.send({
        type: 'workspace/revoke-share',
        vaultId: entry.vaultId,
        entryId: entry.id,
        shareId,
      });
      await load();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function changeProtection() {
    if (!entry || !changing) return;
    if (
      !validShareProtection(
        protection,
        protection === 'none' ? null : secret,
      ) ||
      (protection !== 'none' && secret !== confirmation)
    ) {
      setInputError(true);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      await client.send({
        type: 'workspace/protect-share',
        vaultId: entry.vaultId,
        entryId: entry.id,
        shareId: changing,
        protection,
        protectionSecret: protection === 'none' ? null : secret,
      });
      setChanging(null);
      setSecret('');
      await load();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="workspace-panel sharing-panel"
      aria-label={t('workspace.shares')}
    >
      <div className="workspace-heading">
        <div>
          <h2>{t('workspace.shares')}</h2>
          <p>{t('share.subtitle')}</p>
        </div>
      </div>
      <label className="workspace-label">
        {t('share.entry')}
        <select
          value={entryKey}
          disabled={busy}
          onChange={(event) => setEntryKey(event.target.value)}
        >
          <option value="">{t('detail.select')}</option>
          {entries.map((entry) => (
            <option
              key={`${entry.vaultId}:${entry.id}`}
              value={`${entry.vaultId}:${entry.id}`}
            >
              {entry.name} · {entry.vaultName}
            </option>
          ))}
        </select>
      </label>
      {entry ? (
        <>
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              void (changing ? changeProtection() : create());
            }}
          >
            <h3>{t(changing ? 'share.changeProtection' : 'share.create')}</h3>
            {links.length ? (
              <div className="share-result">
                <p>{t('share.linkNotice')}</p>
                {links.map((link) => (
                  <div className="share-link-result" key={link.operationId}>
                    <label>
                      {link.email ?? t('share.anyone')}
                      <input
                        aria-label={t('share.link')}
                        readOnly
                        value={link.url}
                      />
                    </label>
                    <Button
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(link.url)
                          .then(() => vaultClient.armClipboardClear())
                          .then(() => setCopied(link.operationId))
                          .catch(() => setError(true))
                      }
                    >
                      {t(
                        copied === link.operationId
                          ? 'share.copied'
                          : 'share.copy',
                      )}
                    </Button>
                  </div>
                ))}
                {attempt && links.length < attempt.length ? (
                  <Button disabled={busy} onClick={() => void create()}>
                    {t('share.retry')}
                  </Button>
                ) : null}
                <Button variant="subtle" disabled={busy} onClick={reset}>
                  {t('share.new')}
                </Button>
              </div>
            ) : (
              <>
                <fieldset disabled={busy || attempt !== null}>
                  {!changing ? (
                    <>
                      <div className="workspace-form-grid">
                        <label>
                          {t('share.expiry')}
                          <select
                            value={hours}
                            onChange={(event) =>
                              setHours(
                                Number(event.target.value) as typeof hours,
                              )
                            }
                          >
                            {[1, 24, 72, 168].map((value) => (
                              <option key={value} value={value}>
                                {t('share.hours', { count: value })}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t('share.receipts')}
                          <input
                            type="number"
                            min="1"
                            max="100"
                            placeholder={t('share.unlimited')}
                            value={receipts}
                            onChange={(event) =>
                              setReceipts(event.target.value)
                            }
                          />
                        </label>
                      </div>
                      <label>
                        {t('share.recipients')}
                        <select
                          value={named ? 'named' : 'anyone'}
                          onChange={(event) =>
                            setNamed(event.target.value === 'named')
                          }
                        >
                          <option value="anyone">{t('share.anyone')}</option>
                          <option value="named">{t('share.named')}</option>
                        </select>
                      </label>
                      {named ? (
                        <label>
                          {t('share.email')}
                          <input
                            type="text"
                            required
                            placeholder={t('share.emailsHint')}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  <div className="workspace-form-grid">
                    <label>
                      {t('share.protection')}
                      <select
                        value={protection}
                        onChange={(event) => {
                          setProtection(event.target.value as ShareProtection);
                          setSecret('');
                          setConfirmation('');
                        }}
                      >
                        <option value="none">{t('share.none')}</option>
                        <option value="password">{t('share.password')}</option>
                        <option value="pin">{t('share.pin')}</option>
                      </select>
                    </label>
                    {protection !== 'none' ? (
                      <label>
                        {t(
                          protection === 'pin' ? 'share.pin' : 'share.password',
                        )}
                        <input
                          type="password"
                          autoComplete="new-password"
                          minLength={protection === 'pin' ? 6 : 8}
                          maxLength={128}
                          pattern={
                            protection === 'pin' ? '[0-9]{6,128}' : undefined
                          }
                          required
                          value={secret}
                          onChange={(event) => setSecret(event.target.value)}
                        />
                      </label>
                    ) : null}
                  </div>
                  {protection !== 'none' ? (
                    <label>
                      {t('share.confirmSecret')}
                      <input
                        type="password"
                        autoComplete="new-password"
                        required
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                      />
                    </label>
                  ) : null}
                  {!changing ? (
                    <label className="workspace-check">
                      <input
                        type="checkbox"
                        checked={notify}
                        onChange={(event) => setNotify(event.target.checked)}
                      />
                      {t('share.notify')}
                    </label>
                  ) : null}
                </fieldset>
                {inputError ? (
                  <p role="alert">{t('share.inputError')}</p>
                ) : null}
                {attempt && error ? <p>{t('share.retryNotice')}</p> : null}
                <div className="workspace-actions">
                  <Button type="submit" loading={busy}>
                    {t(
                      changing
                        ? 'share.save'
                        : attempt
                          ? 'share.retry'
                          : 'share.create',
                    )}
                  </Button>
                  {attempt || changing ? (
                    <Button variant="subtle" disabled={busy} onClick={reset}>
                      {t('common.cancel')}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </form>
          {error ? <p role="alert">{t('workspace.error')}</p> : null}
          <h3>{t('share.existing')}</h3>
          {!items.length ? (
            <p className="workspace-empty">{t(loadingList ? 'workspace.loading' : 'share.empty')}</p>
          ) : (
            items.map((item) => (
              <article className="share-row" key={item.shareId}>
                <div>
                  <strong>{item.recipientEmail ?? t('share.anyone')}</strong>
                  <p>
                    {t('share.expires', {
                      date: new Date(item.expiresAt).toLocaleString(locale),
                    })}{' '}
                    · {t('share.deliveries', { count: item.deliveryCount })}
                  </p>
                  <small>
                    {item.status}
                    {item.sourceChanged ? ` · ${t('share.sourceChanged')}` : ''}
                  </small>
                </div>
                {item.status === 'active' ? (
                  <div className="workspace-actions">
                    <Button
                      variant="subtle"
                      disabled={busy}
                      onClick={() => {
                        reset();
                        setProtection(
                          item.protection === 'pin' ||
                            item.protection === 'password'
                            ? item.protection
                            : 'none',
                        );
                        setChanging(item.shareId);
                      }}
                    >
                      {t('share.changeProtection')}
                    </Button>
                    <Button
                      variant="subtle"
                      disabled={busy}
                      onClick={() => void revoke(item.shareId)}
                    >
                      {t('share.revoke')}
                    </Button>
                  </div>
                ) : null}
              </article>
            ))
          )}
          {cursor ? (
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() => void load(cursor)}
            >
              {t('workspace.more')}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="workspace-empty">{t('share.choose')}</p>
      )}
    </section>
  );
}
