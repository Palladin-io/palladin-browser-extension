import { EntryScopeHeader } from '../components/EntryScopeHeader';
import { EntryIcon } from '../components/EntryIcon';
import { PopupIcon } from '../components/PopupIcon';
import { FilterSelect } from '../components/FilterSelect';
import { RefreshButton } from '../components/RefreshButton';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { WorkspaceError } from './WorkspaceError';
import { useEffect, useRef, useState } from 'react';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import type { OrgGrant } from '../../shared/workspace/contracts';
import type {
  GrantReview,
  WorkspaceCommand,
} from '../../shared/workspace/commands';
import { WorkspaceClientError, type WorkspaceClient } from './client';
import { Button } from '../components/Button';
import { useI18n, type TranslationKey } from '../i18n';
import { AgentIcon } from '../components/AgentIcon';

type Approval = Extract<WorkspaceCommand, { type: 'workspace/approve-grant' }>;
const states: Record<string, TranslationKey> = {
  pending: 'grant.pending',
  active: 'grant.active',
  denied: 'grant.denied',
  revoked: 'grant.revoked',
  expired: 'grant.expired',
  consumed: 'grant.consumed',
  superseded: 'grant.superseded',
};
const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
export function GrantsPanel({
  client,
  revision,
  entries,
  entryId,
  vaultId,
  onBack,
}: {
  client: WorkspaceClient;
  revision: number;
  entries: readonly EntryMetadata[];
  entryId?: string | undefined;
  vaultId?: string | undefined;
  onBack?: (() => void) | undefined;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<OrgGrant[]>([]);
  const [status, setStatus] = useState<string[]>([]);
  const [cursor, setCursor] = useState<Record<string, string> | null>(null);
  const [selected, setSelected] = useState<OrgGrant | null>(null);
  const [accessReason, setAccessReason] = useState<string | null>(null);
  const [reasonFailure, setReasonFailure] = useState<string | null>(null);
  const [reasonLoading, setReasonLoading] = useState(false);
  const reasonRun = useRef(0);
  const [review, setReview] = useState<GrantReview | null>(null);
  const [actionBusy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = actionBusy || loading;
  const [error, setError] = useState<unknown>(null);
  const [policy, setPolicy] = useState<'time' | 'uses' | 'lifetime'>('time');
  const [duration, setDuration] = useState('15');
  const [customDate, setCustomDate] = useState('');
  const [uses, setUses] = useState(1);
  const [methods, setMethods] = useState(0);
  const [fields, setFields] = useState<string[]>([]);
  const [allFields, setAllFields] = useState(true);
  const [reason, setReason] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  async function load(next?: Record<string, string>, quiet = false) {
    const run = ++generation.current;
    if (!quiet) setLoading(true);
    setError(false);
    try {
      const keys = next ? Object.keys(next) : status.length ? status : [''];
      const pages = await Promise.all(keys.map(async key => ({ key, page: await client.send({
        type: 'workspace/grants',
        ...(key ? { status: key } : {}),
        ...(entryId ? { entryId } : {}),
        ...(vaultId ? { vaultId } : {}),
        ...(next?.[key] ? { cursor: next[key] } : {}),
      }) })));
      const page = { items: pages.flatMap(result => result.page.items).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)) };
      const nextCursors = Object.fromEntries(pages.flatMap(result => result.page.nextCursor ? [[result.key, result.page.nextCursor]] : []));

      if (!mounted.current || run !== generation.current) return;
      setItems(previous => (next
        ? [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))]
        : page.items).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)));
      setCursor(Object.keys(nextCursors).length ? nextCursors : null);
    } catch (error) {
      if (mounted.current && run === generation.current) setError(error);
    } finally {
      if (mounted.current && run === generation.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoading(true);
    setSelected(null);
    setReview(null);
    return () => {
      generation.current++;
    };
  }, [client, status, entryId, vaultId]);
  useEffect(() => {
    void load(undefined, items.length > 0);
  }, [client, status, entryId, vaultId, revision]);
  async function select(grant: OrgGrant) {
    setSelected(grant);
    setReview(null);
    setError(false);
    setReason('');
    setAccessReason(null);
    setReasonFailure(null);
    const run = ++reasonRun.current;
    setReasonLoading(Boolean(grant.encryptedReason));
    if (grant.encryptedReason) void client.send({ type: 'workspace/grant-reason', vaultId: grant.vaultId, grantId: grant.id })
      .then(data => { if (mounted.current && run === reasonRun.current) setAccessReason(data.reason); })
      .catch(error => { if (mounted.current && run === reasonRun.current) setReasonFailure(error instanceof WorkspaceClientError ? error.code : 'worker'); })
      .finally(() => { if (mounted.current && run === reasonRun.current) setReasonLoading(false); });
    if (grant.status !== 'pending') return;
    setBusy(true);
    try {
      const data = await client.send({
        type: 'workspace/review-grant',
        vaultId: grant.vaultId,
        grantId: grant.id,
      });
      if (!mounted.current || run !== reasonRun.current) return;
      setReview(data);
      setMethods(data.methods);
      setFields(data.fields.map((field) => field.id));
      setAllFields(true);
    } catch (error) {
      if (mounted.current) setError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function decide(action: 'approve' | 'deny' | 'revoke') {
    if (!selected || busy) return;
    setBusy(true);
    setError(false);
    try {
      if (action === 'approve') {
        if (!review) return;
        const selectedPolicy: Approval['policy'] =
          policy === 'uses'
            ? { kind: 'uses', queryLimit: uses }
            : policy === 'lifetime'
              ? { kind: 'lifetime' }
              : {
                  kind: 'time',
                  expiresAt:
                    duration === 'custom'
                      ? new Date(customDate).toISOString()
                      : new Date(
                          Date.now() + Number(duration) * 60_000,
                        ).toISOString(),
                };
        await client.send({
          type: 'workspace/approve-grant',
          vaultId: selected.vaultId,
          grantId: selected.id,
          entryId: review.entryId,
          revision: review.revision,
          methods,
          fields: allFields ? review.fields.map((field) => field.id) : fields,
          selection: allFields ? 'all' : 'selected',
          policy: selectedPolicy,
        });
      } else
        await client.send(
          action === 'deny'
            ? {
                type: 'workspace/deny',
                vaultId: selected.vaultId,
                grantId: selected.id,
                reason: reason.trim(),
              }
            : {
                type: 'workspace/revoke-grant',
                vaultId: selected.vaultId,
                grantId: selected.id,
              },
        );
      if (!mounted.current) return;
      setSelected(null);
      setReview(null);
      await load();
    } catch (error) {
      if (mounted.current) {
        setError(error);
        if (action === 'approve') setReview(null);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const entry = selected
    ? entries.find(
        (entry) =>
          entry.id === (selected.entryId ?? selected.scriptEntryId) &&
          entry.vaultId === selected.vaultId,
      )
    : null;
  const selectedVaultName = entry?.vaultName ?? entries.find(item => item.vaultId === selected?.vaultId)?.vaultName ?? selected?.vaultName;
  return (
    <section
      className="workspace-panel grants-panel"
      aria-label={t(entryId ? 'workspace.grants' : 'workspace.inbox')}
    >
      {error ? <WorkspaceError error={error} /> : null}
      <div className="grants-layout">
        <div className="grant-sidebar">
          <div className="grant-list-controls">
            {entryId ? <EntryScopeHeader entry={entries.find(entry => entry.id === entryId && entry.vaultId === vaultId)} onBack={onBack} /> : (<FilterSelect multiple aria-label={t('grant.filter')} value={status} disabled={actionBusy}
              onValueChange={setStatus}>
              <option value="">{t('grant.all')}</option>
              {Object.entries(states).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
            </FilterSelect>)}
            <RefreshButton busy={busy} onClick={() => void load()} />
          </div>
          <div className="grant-list">
          {items.map((grant) => (
            <button
              key={grant.id}
              disabled={busy}
              className="grant-row"
              aria-pressed={selected?.id === grant.id}
              onClick={() => void select(grant)}
            >
              <AgentIcon iconKey={grant.agentIconKey} />
              <span className="grant-row-content">
                <strong title={grant.agentName ?? (grant.agentId ? shortId(grant.agentId) : t('grant.agent'))}>{grant.agentName ?? (grant.agentId ? shortId(grant.agentId) : t('grant.agent'))}</strong>
                <span className="grant-list-resource">
                  <small title={entries.find(entry => entry.id === (grant.entryId ?? grant.scriptEntryId) && entry.vaultId === grant.vaultId)?.name ?? t('grant.entry')}>{entries.find(entry => entry.id === (grant.entryId ?? grant.scriptEntryId) && entry.vaultId === grant.vaultId)?.name ?? t('grant.entry')}</small>
                  <span className="grant-status" data-status={grant.status} data-pending={grant.status === 'pending'}>{states[grant.status] ? t(states[grant.status]!) : grant.status}</span>
                </span>
              </span>
            </button>
          ))}
          {busy && !items.length ? <LoadingSkeleton /> : !error && !items.length ? <p className="workspace-empty">{t('grant.empty')}</p> : null}
          {cursor ? (
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() => void load(cursor)}
            >
              {t('workspace.more')}
            </Button>
          ) : null}
        </div>
        </div>
        {selected ? (
          <div className="entry-detail grant-detail">
            <div className="grant-information">
            <div className="grant-summary-card"><div className="grant-identities">
<div className="grant-identity-column"><h4>{t('grant.agent')}</h4>            <div className="grant-agent-line"><AgentIcon iconKey={selected.agentIconKey} /><span className="grant-agent-identity"><strong title={selected.agentName ?? t('grant.agent')}>{selected.agentName ?? t('grant.agent')}</strong>
              <span className="grant-status" data-status={selected.status} data-pending={selected.status === 'pending'}>{states[selected.status] ? t(states[selected.status]!) : selected.status}</span></span>
            </div>
</div>
<div className="grant-identity-column"><h4>{t('grant.resource')}</h4>            <div className="detail-heading grant-detail-heading">
              {entry ? <EntryIcon name={entry.name} type={entry.type} {...(entry.icon ? { icon: entry.icon } : {})} {...(entry.color ? { color: entry.color } : {})} /> : <span className="grant-avatar"><PopupIcon name={selected.type === 'full' ? 'vault' : 'key'} /></span>}
              <div className="detail-identity"><h2 title={entry?.name ?? selected.entryLabel ?? (selected.type === 'full' ? t('grant.wholeVault') : t('grant.entry'))}>{entry?.name ?? selected.entryLabel ?? (selected.type === 'full' ? t('grant.wholeVault') : t('grant.entry'))}</h2>
                <p title={selectedVaultName ?? shortId(selected.vaultId)}><PopupIcon name="vault" />{selectedVaultName ?? shortId(selected.vaultId)}</p>
              </div>
            </div>
</div></div>
            {selected.canRevoke ? <div className="grant-revoke-action">
              <Button variant="danger" loading={busy} onClick={() => void decide('revoke')}>
                <PopupIcon name="denied" />{t('grant.revoke')}
              </Button>
            </div> : null}
            {selected.encryptedReason ? (
              <section className="grant-purpose" aria-label={t('grant.encryptedReason')}>
                <h4>{t('grant.encryptedReason')}</h4>
                <p title={accessReason ?? review?.reason ?? undefined} tabIndex={0}>{accessReason ?? review?.reason ?? t(reasonLoading ? 'workspace.loading' : 'grant.reasonUnavailable')}{!accessReason && !review?.reason && !reasonLoading && reasonFailure ? ` [${reasonFailure}]` : ''}</p>
              </section>
            ) : null}
            </div>
            <dl className="grant-metadata">
              <div className="detail-field"><dt>{t('grant.expiresAt')}</dt><dd>{selected.expiresAt ? new Date(selected.expiresAt).toLocaleString(locale) : t(selected.status === 'pending' ? 'grant.expiryOnApproval' : 'grant.noExpiry')}</dd></div>
              <div className="detail-field"><dt>{t('grant.requestedAt')}</dt><dd>{new Date(selected.createdAt).toLocaleString(locale)}</dd></div>
              {selected.createdBy ? <>
                <div className="detail-field"><dt>{t('grant.grantedBy')}</dt><dd>{selected.createdByName ?? shortId(selected.createdBy)}</dd></div>
                <div className="detail-field"><dt>{t('grant.grantedAt')}</dt><dd>{selected.grantedAt ? new Date(selected.grantedAt).toLocaleString(locale) : t('grant.dateUnavailable')}</dd></div>
              </> : null}
            </dl></div>
            {selected.status === 'pending' ? (
              <form
                className="workspace-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void decide('approve');
                }}
              >
                {review ? (
                  <>
                    <fieldset disabled={busy}>
                      <div className="grant-control-section">
                      <label>
                        {t('grant.limit')}
                        <FilterSelect
                          aria-label={t('grant.limit')}
                          value={policy}
                          disabled={busy}
                          onValueChange={value => setPolicy(value as typeof policy)}
                        >
                          <option value="time">{t('grant.time')}</option>
                          <option value="uses">{t('grant.uses')}</option>
                          <option value="lifetime">
                            {t('grant.lifetime')}
                          </option>
                        </FilterSelect>
                      </label>
                      {policy === 'time' ? (
                        <>
                          <div className="grant-duration" role="group" aria-label={t('grant.duration')}>
                            <span className="field-label">{t('grant.duration')}</span>
                            <div className="grant-duration-grid">
                              {[5, 15, 30, 60, 120, 360, 720, 1440].map(value => (
                                <button type="button" key={value} aria-pressed={duration === String(value)} onClick={() => setDuration(String(value))}>
                                  {t(value < 60 ? 'grant.minutes' : 'grant.hours', { count: value < 60 ? value : value / 60 })}
                                </button>
                              ))}
                            </div>
                            <button type="button" className="grant-custom-duration" aria-pressed={duration === 'custom'} onClick={() => setDuration('custom')}>{t('grant.custom')}</button>
                          </div>
                          {duration === 'custom' ? (
                            <input
                              aria-label={t('grant.custom')}
                              required
                              type="datetime-local"
                              value={customDate}
                              onChange={(event) =>
                                setCustomDate(event.target.value)
                              }
                            />
                          ) : null}
                        </>
                      ) : policy === 'uses' ? (
                        <label>
                          {t('grant.uses')}
                          <input
                            type="number"
                            required
                            min={1}
                            max={2147483647}
                            value={uses}
                            onChange={(event) =>
                              setUses(Number(event.target.value))
                            }
                          />
                        </label>
                      ) : (
                        <p>{t('grant.lifetimeWarning')}</p>
                      )}
                      </div>
                      <div className="grant-control-section">
                      <p className="field-label">{t('grant.methods')}</p>
                      {([1, 2, 4] as const)
                        .filter((bit) => review.methods & bit)
                        .map((bit) => (
                          <label key={bit} className="workspace-check">
                            <input
                              type="checkbox"
                              checked={!!(methods & bit)}
                              onChange={(event) =>
                                setMethods((mask) =>
                                  event.target.checked
                                    ? mask | bit
                                    : mask & ~bit,
                                )
                              }
                            />
                            {t(
                              bit === 1
                                ? 'grant.get'
                                : bit === 2
                                  ? 'grant.exec'
                                  : 'grant.inject',
                            )}
                          </label>
                        ))}
                      {([1, 2, 4] as const).some(bit => !(review.methods & bit)) ? (
                        <details className="grant-other-methods">
                          <summary>{t('grant.otherMethods')}<PopupIcon name="chevron" /></summary>
                          <div className="grant-other-method-options">
                            <p>{t('grant.unrequestedMethods')}</p>
                            {([1, 2, 4] as const).filter(bit => !(review.methods & bit)).map(bit => (
                              <label key={bit} className="workspace-check">
                                <input type="checkbox" checked={false} disabled />
                                {t(bit === 1 ? 'grant.get' : bit === 2 ? 'grant.exec' : 'grant.inject')}
                              </label>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {methods & 1 ? (
                        <p className="grant-reason">{t('grant.getWarning')}</p>
                      ) : null}
                      </div>
                      {review.grant.type === 'granular' ? (
                        <div className="grant-control-section">
                          <p className="field-label">{t('grant.fieldsLabel')}</p>
                          <label className="workspace-check">
                            <input
                              type="checkbox"
                              checked={allFields}
                              onChange={(event) =>
                                setAllFields(event.target.checked)
                              }
                            />
                            {t('grant.allFields')}
                          </label>
                          {!allFields
                            ? review.fields.map((field) => (
                                <label
                                  className="workspace-check"
                                  key={field.id}
                                >
                                  <input
                                    type="checkbox"
                                    checked={fields.includes(field.id)}
                                    onChange={(event) =>
                                      setFields((previous) =>
                                        event.target.checked
                                          ? [...previous, field.id]
                                          : previous.filter(
                                              (id) => id !== field.id,
                                            ),
                                      )
                                    }
                                  />
                                  {field.label}
                                </label>
                              ))
                            : null}
                        </div>
                      ) : null}
                    </fieldset>
                  </>
                ) : (
                  <Button
                    variant="subtle"
                    disabled={busy}
                    onClick={() => void select(selected)}
                  >
                    {t('grant.review')}
                  </Button>
                )}
                <div className="grant-decision-actions">
                  <Button type="button" variant="danger" disabled={busy} onClick={() => void decide('deny')}>
                    {t('grant.deny')}
                  </Button>
                    <Button
                      type="submit"
                      variant="positive"
                      loading={busy}
                      disabled={
                        !review || !methods ||
                        (review?.grant.type === 'granular' &&
                          !allFields &&
                          !fields.length)
                      }
                    >
                      {t('grant.approve')}
                    </Button>
                </div>
                <label className="grant-denial-reason">
                  {t('grant.denyReason')}
                  <input
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>

              </form>
            ) : null}
          </div>
        ) : (
          <div className="detail-empty">{t('grant.select')}</div>
        )}
      </div>
    </section>
  );
}
