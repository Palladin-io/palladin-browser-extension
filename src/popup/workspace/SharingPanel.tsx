import { PopupIcon } from '../components/PopupIcon';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { WorkspaceError } from './WorkspaceError';
import { EntryIcon } from '../components/EntryIcon';
import {
  sharingRecipients,
  validShareProtection,
} from '../../shared/workspace/sharing-input';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type {
  EntryShareListItem,
  ShareProtection,
} from '../../shared/workspace/contracts';
import type { WorkspaceCommand } from '../../shared/workspace/commands';
import type { WorkspaceClient } from './client';
import type { VaultClient } from '../vault/client';
import { useI18n, type TranslationKey } from '../i18n';
import { Button } from '../components/Button';

const shareStates: Record<string, TranslationKey> = {
  active: 'grant.active',
  revoked: 'grant.revoked',
  expired: 'grant.expired',
  consumed: 'grant.consumed',
  locked: 'share.locked',
  suspended: 'share.suspended',
};

type CreateCommand = Extract<
  WorkspaceCommand,
  { type: 'workspace/create-share' }
>;
export function SharingPanel({
  client,
  vaultClient,
  entries,
  initialEntry,
  initialCreate = false,
  embedded = false,
  onClose,
  heading,
}: {
  client: WorkspaceClient;
  vaultClient: VaultClient;
  entries: readonly EntryMetadata[];
  initialEntry?: EntryMetadata | undefined;
  initialCreate?: boolean;
  embedded?: boolean;
  onClose?: () => void;
  heading?: ReactNode;
}): React.JSX.Element {
  const formId = useId();
  const [creating, setCreating] = useState(initialCreate);
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
  const [error, setError] = useState<unknown>(null);
  const [links, setLinks] = useState<
    { url: string; email: string | null; operationId: string }[]
  >([]);
  const [attempt, setAttempt] = useState<CreateCommand[] | null>(null);
  const [shownLinks, setShownLinks] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
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
    } catch (error) {
      if (generation.current === revision && alive.current) setError(error);
    } finally {
      if (generation.current === revision && alive.current)
        setLoadingList(false);
    }
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
    setCopyFailed(false);
    setShownLinks([]);
    setChanging(null);
  }
  useEffect(() => {
    reset();
    setItems([]);
    setCursor(null);
    if (!creating) void load();
    return () => {
      generation.current++;
    };
  }, [entryKey, client, creating]);
  async function create() {
    if (!entry || busy) return;
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
      const createdLinks = [...links];
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
        createdLinks.push({ url: result.url, email: command.recipientEmail, operationId: command.operationId });
        setLinks([...createdLinks]);
      }
      await copyLinks(createdLinks);
      setSecret('');
      setConfirmation('');
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function copyLinks(values = links) {
    if (!alive.current || !values.length) return;
    try {
      const text = values.length === 1 ? values[0]!.url : values.map(link => `${link.email ?? t('share.anyone')}: ${link.url}`).join('\n');
      await navigator.clipboard.writeText(text);
      await vaultClient.armClipboardClear();
      if (alive.current) { setCopied(values.map(link => link.operationId).join(',')); setCopyFailed(false); }
    } catch {
      if (alive.current) setCopyFailed(true);
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
    } catch (error) {
      if (alive.current) setError(error);
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
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="workspace-panel sharing-panel"
      aria-label={t('workspace.shares')}
    >
      {embedded ? <div className="detail-heading">{heading}
        {!links.length ? <Button type="submit" form={formId} loading={busy}>{t(attempt ? 'share.retry' : 'share.create')}</Button> : null}
      </div> : null}
      {!embedded ? <div className="workspace-heading">
        <div>
          {!embedded ? <h2>{t('workspace.shares')}</h2> : null}
          {entry && !embedded ? <p>{entry.name} · {entry.vaultName}</p> : null}
        </div>
        {onClose ? <Button variant="ghost" onClick={onClose}>{t('common.back')}</Button> : null}
        {entry && !creating && !changing ? <Button onClick={() => setCreating(true)}>{t('share.create')}</Button> : null}
      </div> : null}
      {!initialEntry ? <label className="workspace-label">
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
      </label> : null}
      {entry ? (
        <>
          {creating || changing ? <form
            id={formId} className="workspace-form" noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void (changing ? changeProtection() : create());
            }}
          >
            {!embedded ? <div className="share-source"><EntryIcon name={entry.name} type={entry.type} {...(entry.icon ? {icon: entry.icon} : {})} /><span><strong>{entry.name}</strong><small>{entry.vaultName}</small></span></div> : null}
            {!embedded ? <h3>{t(links.length ? 'share.created' : changing ? 'share.changeProtection' : 'share.create')}</h3> : null}
            {!links.length && !changing ? <p className="share-hint">{t('share.snapshotNotice')}</p> : null}
            {links.length ? (
              <div className="share-result">
                <p>{t('share.linkNotice')}</p>
                {links.map((link) => (
                  <div className="share-link-result" key={link.operationId}>
                    <label>
                      {link.email ?? t('share.anyone')}
                      <span className="share-link-input"><input
                        aria-label={t('share.link')}
                        type={shownLinks.includes(link.operationId) ? 'text' : 'password'}
                        readOnly
                        value={link.url}
                      />
                    <button type="button" className="toolbar-icon" aria-label={t(shownLinks.includes(link.operationId) ? 'field.hide' : 'field.show')}
                      onClick={() => setShownLinks(current => current.includes(link.operationId) ? current.filter(id => id !== link.operationId) : [...current, link.operationId])}>
                      <PopupIcon name={shownLinks.includes(link.operationId) ? 'eye-off' : 'eye'} />
                    </button>
                      </span>
                    </label>
                  </div>
                ))}
                {attempt && links.length < attempt.length ? (
                  <Button disabled={busy} onClick={() => void create()}>
                    {t('share.retry')}
                  </Button>
                ) : null}
                <div className="workspace-actions share-result-actions">
                  <Button variant="subtle" disabled={busy} onClick={() => void copyLinks()}>{t(copied === links.map(link => link.operationId).join(',') ? 'share.copied' : links.length > 1 ? 'share.copyAll' : 'share.copy')}</Button>
                  <Button disabled={busy} onClick={() => { reset(); setCreating(false); if (embedded) onClose?.(); }}>{t('share.done')}</Button>
                </div>
                {copyFailed ? <p role="status">{t('share.copyFailed')}</p> : null}
              </div>
            ) : (
              <>
                <fieldset disabled={busy || attempt !== null}>
                  {!changing ? (
                    <>
                      <details className="share-section"><summary><span>{t('share.recipients')}</span><span>{named ? email || t('share.named') : t('share.anyone')}</span><PopupIcon name="chevron" /></summary><div>
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
                      <p className="share-hint">{t(named ? 'share.emailNotice' : 'share.anyoneWarning')}</p>
                      </div></details>
                    </>
                  ) : null}
                  <details className="share-section" open={changing ? true : undefined}><summary><span>{t('share.protection')}</span><span>{t(protection === 'none' ? 'share.none' : protection === 'pin' ? 'share.pin' : 'share.password')}</span><PopupIcon name="chevron" /></summary><div>
                  <>
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
                  </>
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
                  {protection !== 'none' ? <p className="share-hint">{t('share.separateChannel')}</p> : null}
                  </div></details>
                  {!changing ? <>
                    <details className="share-section"><summary><span>{t('share.expiry')}</span><span>{t('share.hours', {count: hours})}</span><PopupIcon name="chevron" /></summary><div>

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
                    </div></details>
                    <details className="share-section"><summary><span>{t('share.receipts')}</span><span>{receipts || t('share.unlimited')}</span><PopupIcon name="chevron" /></summary><div>
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
                                          </div></details>
                  </> : null}
                  {!changing ? (
                    <label className="workspace-check share-notify">
                      <input
                        type="checkbox"
                        role="switch"
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
                {!embedded ? <div className="workspace-actions share-form-actions">
                  <Button type="submit" loading={busy}>
                    {t(
                      changing
                        ? 'share.save'
                        : attempt
                          ? 'share.retry'
                          : 'share.create',
                    )}
                  </Button>
                  <Button variant="subtle" disabled={busy} onClick={() => { reset(); setCreating(false); if (embedded) onClose?.(); }}>
                      {t('common.cancel')}
                    </Button>
                </div> : null}
              </>
            )}
          </form> : null}
          {error ? <WorkspaceError error={error} /> : null}
          {!creating && !changing ? <>
          <h3>{t('share.existing')}</h3>
          {loadingList && !items.length ? <LoadingSkeleton /> : !items.length ? (
            !error ? <p className="workspace-empty">{t('share.empty')}</p> : null
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
                    {t(shareStates[item.status] ?? 'share.unknownStatus')}
                    {item.sourceChanged ? ` · ${t('share.sourceChanged')}` : ''}
                  </small>
                </div>
                {['active', 'locked', 'suspended', 'consumed'].includes(
                  item.status,
                ) ? (
                  <div className="workspace-actions">
                    {item.status === 'active' ? (
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
                    ) : null}
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
          </> : null}
        </>
      ) : (
        <p className="workspace-empty">{t('share.choose')}</p>
      )}
    </section>
  );
}
