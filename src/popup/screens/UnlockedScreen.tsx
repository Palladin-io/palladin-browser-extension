import { GrantsPanel } from '../workspace/GrantsPanel';
import { SharingPanel } from '../workspace/SharingPanel';
import { AuditPanel } from '../workspace/AuditPanel';
import { createWorkspaceClient } from '../workspace/client';
import type { EntryMetadata } from '../../background/vault/entry-metadata';
import { Header } from '../components/Header';
import { PopupIcon } from '../components/PopupIcon';
import { EntryDetail } from '../components/EntryDetail';
import { useMemo, useState } from 'react';
import brandLogoUrl from '../../../icons/logo-source.png';

import { CapturePrompt } from '../capture/CapturePrompt';
import { AddEntryForm } from '../entries/AddEntryForm';
import { createCaptureClient, type CaptureClient } from '../capture/client';
import { useCapturePrompt } from '../capture/useCapturePrompt';
import { Button } from '../components/Button';
import { EntryList } from '../components/EntryList';
import { ListSkeleton } from '../components/ListSkeleton';
import { SearchBar } from '../components/SearchBar';
import { GeneratorPanel } from '../generator/GeneratorPanel';
import { createVaultClient, type VaultClient } from '../vault/client';
import { filterEntries } from '../vault/filter';
import { useVaultList } from '../vault/useVaultList';
import { webAppUrl } from '@shared/config/web-app';
import { useI18n } from '../i18n';

/**
 * The unlocked home: search, the entries for the current site, and the full
 * vault list — plus the two session actions in a compact footer. The vault
 * client is injectable so the screen is testable against a fake command channel
 * with no live `chrome`; the search bar and footer stay visible while the list
 * region loads (skeleton is scoped to the list only).
 */
export interface UnlockedScreenProps {
  onOpenSettings?: (() => void) | undefined;
  onLock(): Promise<void>;
  onSignOut(): Promise<void>;
  /**
   * Value-free worker/tab invalidation. It refreshes only the local list view;
   * the screen itself stays mounted so search, expansion and scroll survive.
   */
  viewRevision?: number;
  /** Present only in the compact popup on targets with a browser-owned panel. */
  onOpenSidePanel?: (() => Promise<boolean>) | undefined;
  /** Injected in tests; defaults to the real `chrome.runtime` vault channel. */
  vaultClient?: VaultClient;
  /** Injected in tests; defaults to the worker-owned capture prompt channel. */
  captureClient?: CaptureClient;
}

export function UnlockedScreen({
  onOpenSettings,
  onLock,
  onSignOut,
  viewRevision = 0,
  onOpenSidePanel,
  vaultClient,
  captureClient,
}: UnlockedScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const client = useMemo(
    () => vaultClient ?? createVaultClient(),
    [vaultClient],
  );
  const promptClient = useMemo(
    () => captureClient ?? createCaptureClient(),
    [captureClient],
  );
  const workspaceClient = useMemo(() => createWorkspaceClient(), []);
  const capture = useCapturePrompt(promptClient);
  const list = useVaultList(client, viewRevision);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<
    'vault' | 'generator' | 'add-entry' | 'logs' | 'shares' | 'grants'
  >('vault');
  const [capturePrompt, setCapturePrompt] = useState(capture.prompt);

  const [scope, setScope] = useState<EntryMetadata | null>(null);
  const [selected, setSelected] = useState<EntryMetadata | null>(null);
  const current = selected
    ? (list.all.find(
        (entry) =>
          entry.id === selected.id && entry.vaultId === selected.vaultId,
      ) ?? null)
    : null;
  const selectedId = current ? `${current.vaultId}:${current.id}` : undefined;

  const searching = query.trim().length > 0;
  const results = useMemo(
    () => filterEntries(list.all, query),
    [list.all, query],
  );

  return (
    <section className="vault">
      <Header>
        <SearchBar
          value={query}
          onChange={(value) => {
            setQuery(value);
            setView('vault');
          }}
        />
        <button
          className="toolbar-icon"
          aria-label={t('vault.generatorTab')}
          title={t('vault.generatorTab')}
          onClick={() => setView(view === 'generator' ? 'vault' : 'generator')}
        >
          <PopupIcon name="key" />
        </button>
        <button
          className="toolbar-icon toolbar-primary"
          aria-label={t('vault.addEntryTab')}
          onClick={() => setView('add-entry')}
        >
          <PopupIcon name="plus" />
        </button>
      </Header>
      <h2 className="sr-only">{t('vault.title')}</h2>
      {capture.prompt !== null && view === 'vault' ? (
        <CapturePrompt
          prompt={capture.prompt}
          onUseStrongPassword={() => {
            setCapturePrompt(capture.prompt);
            setView('generator');
          }}
          onDismiss={() => {
            setCapturePrompt(null);
            void capture.dismiss().catch(() => undefined);
          }}
        />
      ) : null}
      <div
        className="vault-tabs"
        role="tablist"
        aria-label={t('vault.popupView')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'vault'}
          onClick={() => setView('vault')}
        >
          {t('vault.tab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'grants'}
          onClick={() => {
            setScope(null);
            setView('grants');
          }}
        >
          {t('workspace.grants')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'shares'}
          onClick={() => setView('shares')}
        >
          {t('workspace.shares')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'logs'}
          onClick={() => {
            setScope(null);
            setView('logs');
          }}
        >
          {t('workspace.logs')}
        </button>
      </div>

      <div className="vault-content">
        {view === 'generator' || view === 'add-entry' ? (
          <button
            className="link-btn workspace-back"
            onClick={() => setView('vault')}
          >
            <PopupIcon name="back" />
            {t('common.back')}
          </button>
        ) : null}
        {view === 'grants' ? (
          <GrantsPanel
            client={workspaceClient}
            entries={list.all}
            entryId={scope?.id}
            vaultId={scope?.vaultId}
          />
        ) : view === 'shares' ? (
          <SharingPanel
            client={workspaceClient}
            vaultClient={client}
            entries={list.all}
            initialEntry={current ?? undefined}
          />
        ) : view === 'logs' ? (
          <AuditPanel
            client={workspaceClient}
            entries={list.all}
            entryId={scope?.id}
            vaultId={scope?.vaultId}
          />
        ) : view === 'add-entry' ? (
          <AddEntryForm client={client} />
        ) : view === 'generator' ? (
          capturePrompt === null ? (
            <GeneratorPanel client={client} />
          ) : (
            <GeneratorPanel
              client={client}
              capture={{
                site: capturePrompt.site,
                fill: (value) =>
                  promptClient.fillGenerated(capturePrompt.id, value),
                save: (value) => promptClient.save(capturePrompt.id, value),
              }}
            />
          )
        ) : (
          <>
            {list.status === 'loading' ? (
              <ListSkeleton />
            ) : list.status === 'error' ? (
              <div className="vault-error-panel" role="alert">
                <p className="vault-error">
                  {t(loadErrorKey(list.errorCode, list.decryptStage))}
                </p>
                <Button variant="subtle" onClick={list.retry}>
                  {t('vault.retry')}
                </Button>
              </div>
            ) : (
              <div className="vault-split" data-selected={current !== null}>
                <div className="vault-scroll">
                  {!searching && list.forSite.length > 0 ? (
                    <ListSection title={t('vault.forSite')}>
                      <EntryList
                        client={client}
                        entries={list.forSite}
                        selectedId={selectedId}
                        onSelect={setSelected}
                      />
                    </ListSection>
                  ) : null}

                  <ListSection
                    title={searching ? t('vault.results') : t('vault.allItems')}
                  >
                    {results.length === 0 ? (
                      <p className="vault-empty">
                        {searching ? t('vault.noResults') : t('vault.empty')}
                      </p>
                    ) : (
                      <EntryList
                        client={client}
                        entries={results}
                        selectedId={selectedId}
                        onSelect={setSelected}
                      />
                    )}
                  </ListSection>
                </div>
                {current ? (
                  <EntryDetail
                    key={`${current.vaultId}:${current.id}:${current.updatedAt}`}
                    entry={current}
                    client={client}
                    workspaceClient={workspaceClient}
                    onGrants={() => {
                      setScope(current);
                      setView('grants');
                    }}
                    onLogs={() => {
                      setScope(current);
                      setView('logs');
                    }}
                    onShare={() => setView('shares')}
                    onBack={() => setSelected(null)}
                  />
                ) : (
                  <div className="detail-empty">{t('detail.select')}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <UnlockedFooter
        onOpenSettings={onOpenSettings}
        onLock={onLock}
        onSignOut={onSignOut}
        onOpenSidePanel={onOpenSidePanel}
      />
    </section>
  );
}

function loadErrorKey(
  code: ReturnType<typeof useVaultList>['errorCode'],
  stage: ReturnType<typeof useVaultList>['decryptStage'],
):
  | 'vault.loadError'
  | 'vault.loadErrorNetwork'
  | 'vault.loadErrorDecrypt'
  | 'vault.loadErrorVaultProjection'
  | 'vault.loadErrorMemberIndex'
  | 'vault.loadErrorSession' {
  if (code === 'network') return 'vault.loadErrorNetwork';
  if (stage === 'vault-projection') return 'vault.loadErrorVaultProjection';
  if (stage === 'member-index') return 'vault.loadErrorMemberIndex';
  if (code === 'decrypt-failed') return 'vault.loadErrorDecrypt';
  if (code === 'locked' || code === 'not-authenticated')
    return 'vault.loadErrorSession';
  return 'vault.loadError';
}

function ListSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="vault-section">
      <h3 className="vault-section-title">{title}</h3>
      {children}
    </div>
  );
}

function UnlockedFooter({
  onOpenSettings,
  onLock,
  onSignOut,
  onOpenSidePanel,
}: Pick<
  UnlockedScreenProps,
  'onOpenSettings' | 'onLock' | 'onSignOut' | 'onOpenSidePanel'
>): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'lock' | 'signout' | null>(null);

  async function run(
    kind: 'lock' | 'signout',
    action: () => Promise<void>,
  ): Promise<void> {
    setBusy(kind);
    try {
      await action();
    } catch {
      // The worker owns the source of truth; on failure the phase simply stays
      // "unlocked" and the user can retry. No secret to surface.
      setBusy(null);
    }
  }

  return (
    <div className="vault-footer">
      {onOpenSidePanel ? (
        <button
          type="button"
          className="link-btn link-btn--side-panel"
          onClick={() => void onOpenSidePanel().catch(() => false)}
        >
          <SidePanelIcon />
          {t('vault.openSidePanel')}
        </button>
      ) : (
        <button
          type="button"
          className="link-btn link-btn--palladin"
          onClick={() => chrome.tabs.create({ url: webAppUrl })}
        >
          <img
            className="footer-brand-logo"
            src={brandLogoUrl}
            alt=""
            aria-hidden="true"
          />
          {t('vault.openPalladin')}
        </button>
      )}
      <div className="vault-footer-actions">
        {onOpenSettings ? (
          <button
            className="toolbar-icon"
            aria-label={t('common.settings')}
            onClick={onOpenSettings}
          >
            <PopupIcon name="settings" />
          </button>
        ) : null}
        <Button
          variant="subtle"
          onClick={() => run('lock', onLock)}
          loading={busy === 'lock'}
          disabled={busy !== null}
        >
          {t('vault.lock')}
        </Button>
        <Button
          variant="danger"
          onClick={() => run('signout', onSignOut)}
          loading={busy === 'signout'}
          disabled={busy !== null}
        >
          {t('vault.signOut')}
        </Button>
      </div>
    </div>
  );
}

function SidePanelIcon(): React.JSX.Element {
  return (
    <svg className="side-panel-icon" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.25" y="2.75" width="13.5" height="12.5" rx="2" />
      <path d="M11.25 3v12" />
    </svg>
  );
}
