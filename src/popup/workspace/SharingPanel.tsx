import { FilterSelect } from '../components/FilterSelect';
import { configuredPanelUrl } from '@shared/config/web-app';
import { PopupIcon } from '../components/PopupIcon';
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

export const shareStates: Record<string, TranslationKey> = {
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
  initialProtectionShare,
  embedded = false,
  onClose,
  heading,
}: {
  client: WorkspaceClient;
  vaultClient: VaultClient;
  entries: readonly EntryMetadata[];
  initialEntry?: EntryMetadata | undefined;
  initialCreate?: boolean;
  initialProtectionShare?: EntryShareListItem | undefined;
  embedded?: boolean;
  onClose?: () => void;
  heading?: ReactNode;
}): React.JSX.Element {
  const formId = useId();
  const [creating, setCreating] = useState(initialCreate);
  const { t } = useI18n();
  const [entryKey, setEntryKey] = useState(
    initialEntry ? `${initialEntry.vaultId}:${initialEntry.id}` : '',
  );
  const entry = entries.find(
    (entry) => `${entry.vaultId}:${entry.id}` === entryKey,
  );
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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const operationId of operations.current)
        void client
          .send({ type: 'workspace/discard-share', operationId })
          .catch(() => undefined);
    };
  }, [client]);
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
    if (initialProtectionShare) {
      setChanging(initialProtectionShare.shareId);
      setProtection(initialProtectionShare.protection as ShareProtection);
    }
  }, [entryKey, client, creating, initialProtectionShare]);
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
      setConfirmation('');
      if (initialProtectionShare && onClose) onClose();
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
      {embedded ? <div className="detail-heading share-form-identity">{heading}</div> : null}
      {!embedded ? <div className="workspace-heading">
        <div>
          {!embedded ? <h2>{t('workspace.shares')}</h2> : null}
          {entry && !embedded ? <p>{entry.name} · {entry.vaultName}</p> : null}
        </div>
        {onClose ? <Button variant="ghost" onClick={onClose}>{t('common.back')}</Button> : null}
        {entry ? <button type="button" className="toolbar-icon" title={t('vault.openWebPanel')} aria-label={t('vault.openWebPanel')}
          onClick={() => void configuredPanelUrl(`/vaults/${encodeURIComponent(entry.vaultId)}/entries/${encodeURIComponent(entry.id)}`)
            .then(url => chrome.tabs.create({ url })).catch(error => setError(error))}><PopupIcon name="external" /></button> : null}
        {entry && !creating && !changing ? <Button onClick={() => setCreating(true)}>{t('share.create')}</Button> : null}
      </div> : null}
      {!initialEntry ? <label className="workspace-label">
        {t('share.entry')}
        <FilterSelect aria-label={t('share.entry')}
          value={entryKey}
          disabled={busy}
          onValueChange={setEntryKey}
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
        </FilterSelect>
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
                  <Button disabled={busy} onClick={() => { reset(); setCreating(false); if (embedded || initialProtectionShare) onClose?.(); }}>{t('share.done')}</Button>
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
                        <FilterSelect aria-label={t('share.recipients')} disabled={busy || attempt !== null}
                          value={named ? 'named' : 'anyone'}
                          onValueChange={value => setNamed(value === 'named')}
                        >
                          <option value="anyone">{t('share.anyone')}</option>
                          <option value="named">{t('share.named')}</option>
                        </FilterSelect>
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
                      <FilterSelect aria-label={t('share.protection')} disabled={busy || attempt !== null}
                        value={protection}
                        onValueChange={value => {
                          setProtection(value as ShareProtection);
                          setSecret('');
                          setConfirmation('');
                        }}
                      >
                        <option value="none">{t('share.none')}</option>
                        <option value="password">{t('share.password')}</option>
                        <option value="pin">{t('share.pin')}</option>
                      </FilterSelect>
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
                          <FilterSelect aria-label={t('share.expiry')} disabled={busy || attempt !== null}
                            value={String(hours)}
                            onValueChange={value => setHours(Number(value) as typeof hours)}
                          >
                            {[1, 24, 72, 168].map((value) => (
                              <option key={value} value={String(value)}>
                                {t('share.hours', { count: value })}
                              </option>
                            ))}
                          </FilterSelect>
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
                <div className="workspace-actions share-form-actions">
                  <Button type="submit" loading={busy}>
                    {t(
                      changing
                        ? 'share.save'
                        : attempt
                          ? 'share.retry'
                          : 'share.create',
                    )}
                  </Button>
                  <Button variant="subtle" disabled={busy} onClick={() => { reset(); setCreating(false); if (embedded || initialProtectionShare) onClose?.(); }}>
                      {t('common.cancel')}
                    </Button>
                </div>
              </>
            )}
          </form> : null}
          {error ? <WorkspaceError error={error} /> : null}

        </>
      ) : (
        <p className="workspace-empty">{t('share.choose')}</p>
      )}
    </section>
  );
}
