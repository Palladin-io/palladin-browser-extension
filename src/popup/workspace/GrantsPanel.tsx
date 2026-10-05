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
}: {
  client: WorkspaceClient;
  revision: number;
  entries: readonly EntryMetadata[];
  entryId?: string | undefined;
  vaultId?: string | undefined;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<OrgGrant[]>([]);
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<OrgGrant | null>(null);
  const [accessReason, setAccessReason] = useState<string | null>(null);
  const [reasonFailure, setReasonFailure] = useState<string | null>(null);
  const [reasonLoading, setReasonLoading] = useState(false);
  const reasonRun = useRef(0);
  const [review, setReview] = useState<GrantReview | null>(null);
  const [busy, setBusy] = useState(false);
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
  async function load(next?: string, quiet = false) {
    const run = ++generation.current;
    if (!quiet) setBusy(true);
    setError(false);
    try {
      const page = await client.send({
        type: 'workspace/grants',
        ...(status ? { status } : {}),
        ...(entryId ? { entryId } : {}),
        ...(vaultId ? { vaultId } : {}),
        ...(next ? { cursor: next } : {}),
      });
      if (!mounted.current || run !== generation.current) return;
      setItems((previous) =>
        next
          ? [
              ...previous,
              ...page.items.filter(
                (row) => !previous.some((item) => item.id === row.id),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
    } catch (error) {
      if (mounted.current && run === generation.current) setError(error);
    } finally {
      if (mounted.current && run === generation.current && !quiet)
        setBusy(false);
    }
  }
  useEffect(() => {
    setItems([]);
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
    if (!selected) return;
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
      aria-label={t('workspace.grants')}
    >
      {error ? <WorkspaceError error={error} /> : null}
      <div className="grants-layout">
        <div className="grant-sidebar">
          <div className="grant-list-controls">
            <FilterSelect aria-label={t('grant.filter')} value={status} disabled={busy}
              onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t('grant.all')}</option>
              {Object.entries(states).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
            </FilterSelect>
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
              <span>
                <strong>
                  {grant.agentName ??
                    (grant.agentId ? shortId(grant.agentId) : t('grant.agent'))}
                </strong>
                <span
                  className="grant-status"
                  data-pending={grant.status === 'pending'}
                >
                  {states[grant.status]
                    ? t(states[grant.status]!)
                    : grant.status}
                </span>
                <small>
                  {entries.find(
                    (entry) =>
                      entry.id === (grant.entryId ?? grant.scriptEntryId),
                  )?.name ?? t('grant.entry')}
                </small>
                <small>
                  {new Date(grant.createdAt).toLocaleString(locale)}
                </small>
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
            <div className="detail-fields grant-information">
            <div className="detail-field detail-heading grant-detail-heading">
              {entry ? <EntryIcon name={entry.name} type={entry.type} {...(entry.icon ? { icon: entry.icon } : {})} {...(entry.color ? { color: entry.color } : {})} /> : <span className="grant-avatar"><PopupIcon name={selected.type === 'full' ? 'vault' : 'key'} /></span>}
              <div className="detail-identity"><h2>{entry?.name ?? selected.entryLabel ?? (selected.type === 'full' ? t('grant.wholeVault') : t('grant.entry'))}</h2>
                <p><PopupIcon name="vault" />{selectedVaultName ?? shortId(selected.vaultId)}</p>
              </div>
            </div>
            <div className="detail-field grant-agent-line"><AgentIcon iconKey={selected.agentIconKey} /><strong>{selected.agentName ?? t('grant.agent')}</strong>
              <span className="grant-status" data-pending={selected.status === 'pending'}>{states[selected.status] ? t(states[selected.status]!) : selected.status}</span>
            </div>
            {selected.encryptedReason ? (
              <section className="detail-field grant-purpose" aria-label={t('grant.encryptedReason')}>
                <h4>{t('grant.encryptedReason')}</h4>
                <p>{accessReason ?? review?.reason ?? t(reasonLoading ? 'workspace.loading' : 'grant.reasonUnavailable')}{!accessReason && !review?.reason && !reasonLoading && reasonFailure ? ` [${reasonFailure}]` : ''}</p>
              </section>
            ) : null}
            <dl className="grant-metadata">
              {selected.status !== 'pending' ? <div className="detail-field"><dt>{t('grant.expiresAt')}</dt><dd>{selected.expiresAt ? new Date(selected.expiresAt).toLocaleString(locale) : t('grant.noExpiry')}</dd></div> : null}
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
                      <label>
                        {t('grant.limit')}
                        <select
                          value={policy}
                          onChange={(event) =>
                            setPolicy(event.target.value as typeof policy)
                          }
                        >
                          <option value="time">{t('grant.time')}</option>
                          <option value="uses">{t('grant.uses')}</option>
                          <option value="lifetime">
                            {t('grant.lifetime')}
                          </option>
                        </select>
                      </label>
                      {policy === 'time' ? (
                        <>
                          <label>
                            {t('grant.duration')}
                            <select
                              value={duration}
                              onChange={(event) =>
                                setDuration(event.target.value)
                              }
                            >
                              {[5, 15, 30, 60, 120, 360, 720, 1440].map(
                                (value) => (
                                  <option key={value} value={value}>
                                    {t('grant.minutes', { count: value })}
                                  </option>
                                ),
                              )}
                              <option value="custom">
                                {t('grant.custom')}
                              </option>
                            </select>
                          </label>
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
                      <p>{t('grant.methods')}</p>
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
                      {methods & 1 ? (
                        <p className="grant-reason">{t('grant.getWarning')}</p>
                      ) : null}
                      {review.grant.type === 'granular' ? (
                        <>
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
                        </>
                      ) : null}
                    </fieldset>
                    <Button
                      type="submit"
                      loading={busy}
                      disabled={
                        !methods ||
                        (review.grant.type === 'granular' &&
                          !allFields &&
                          !fields.length)
                      }
                    >
                      {t('grant.approve')}
                    </Button>
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
                <label className="grant-denial-reason">
                  {t('grant.denyReason')}
                  <input
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => void decide('deny')}
                >
                  {t('grant.deny')}
                </Button>
              </form>
            ) : (
              <>
                {selected.expiresAt ? (
                  <p>
                    {t('share.expires', {
                      date: new Date(selected.expiresAt).toLocaleString(locale),
                    })}
                  </p>
                ) : null}
                {selected.canRevoke ? (
                  <Button
                    variant="subtle"
                    disabled={busy}
                    onClick={() => void decide('revoke')}
                  >
                    {t('grant.revoke')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="detail-empty">{t('grant.select')}</div>
        )}
      </div>
    </section>
  );
}
