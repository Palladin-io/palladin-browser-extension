import { useMemo, useState } from "react";
import brandLogoUrl from "../../../icons/logo-source.png";

import { CapturePrompt } from "../capture/CapturePrompt";
import { AddEntryForm } from "../entries/AddEntryForm";
import { createCaptureClient, type CaptureClient } from "../capture/client";
import { useCapturePrompt } from "../capture/useCapturePrompt";
import { Button } from "../components/Button";
import { EntryList } from "../components/EntryList";
import { ListSkeleton } from "../components/ListSkeleton";
import { SearchBar } from "../components/SearchBar";
import { GeneratorPanel } from "../generator/GeneratorPanel";
import { createVaultClient, type VaultClient } from "../vault/client";
import { filterEntries } from "../vault/filter";
import { useVaultList } from "../vault/useVaultList";
import { webAppUrl } from "@shared/config/web-app";
import { useI18n } from "../i18n";

/**
 * The unlocked home: search, the entries for the current site, and the full
 * vault list — plus the two session actions in a compact footer. The vault
 * client is injectable so the screen is testable against a fake command channel
 * with no live `chrome`; the search bar and footer stay visible while the list
 * region loads (skeleton is scoped to the list only).
 */
export interface UnlockedScreenProps {
  onLock(): Promise<void>;
  onSignOut(): Promise<void>;
  /** Present only in the compact popup on targets with a browser-owned panel. */
  onOpenSidePanel?: (() => Promise<boolean>) | undefined;
  /** Injected in tests; defaults to the real `chrome.runtime` vault channel. */
  vaultClient?: VaultClient;
  /** Injected in tests; defaults to the worker-owned capture prompt channel. */
  captureClient?: CaptureClient;
}

export function UnlockedScreen({
  onLock,
  onSignOut,
  onOpenSidePanel,
  vaultClient,
  captureClient,
}: UnlockedScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const client = useMemo(() => vaultClient ?? createVaultClient(), [vaultClient]);
  const promptClient = useMemo(
    () => captureClient ?? createCaptureClient(),
    [captureClient],
  );
  const capture = useCapturePrompt(promptClient);
  const list = useVaultList(client);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"vault" | "generator" | "add-entry">("vault");
  const [capturePrompt, setCapturePrompt] = useState(capture.prompt);

  const searching = query.trim().length > 0;
  const results = useMemo(() => filterEntries(list.all, query), [list.all, query]);

  return (
    <section className="vault">
      <h2 className="sr-only">{t("vault.title")}</h2>
      {capture.prompt !== null && view === "vault" ? (
        <CapturePrompt
          prompt={capture.prompt}
          onUseStrongPassword={() => {
            setCapturePrompt(capture.prompt);
            setView("generator");
          }}
          onDismiss={() => {
            setCapturePrompt(null);
            void capture.dismiss().catch(() => undefined);
          }}
        />
      ) : null}
      <div className="vault-tabs" role="tablist" aria-label={t("vault.popupView")}>
        <button type="button" role="tab" aria-selected={view === "vault"} onClick={() => setView("vault")}>{t("vault.tab")}</button>
        <button type="button" role="tab" aria-selected={view === "generator"} onClick={() => setView("generator")}>{t("vault.generatorTab")}</button>
        <button type="button" role="tab" aria-selected={view === "add-entry"} onClick={() => setView("add-entry")}>{t("vault.addEntryTab")}</button>
      </div>

      {view === "add-entry" ? <AddEntryForm client={client} /> : view === "generator" ? (
        capturePrompt === null ? <GeneratorPanel client={client} /> : (
          <GeneratorPanel
            client={client}
            capture={{
              site: capturePrompt.site,
              fill: (value) => promptClient.fillGenerated(capturePrompt.id, value),
              save: (value) => promptClient.save(capturePrompt.id, value),
            }}
          />
        )
      ) : <>
      <SearchBar value={query} onChange={setQuery} />

      {list.status === "loading" ? (
        <ListSkeleton />
      ) : list.status === "error" ? (
        <div className="vault-error-panel" role="alert">
          <p className="vault-error">
            {t(loadErrorKey(list.errorCode, list.decryptStage))}
          </p>
          <Button variant="subtle" onClick={list.retry}>
            {t("vault.retry")}
          </Button>
        </div>
      ) : (
        <div className="vault-scroll">
          {!searching && list.forSite.length > 0 ? (
            <ListSection title={t("vault.forSite")}>
              <EntryList client={client} entries={list.forSite} />
            </ListSection>
          ) : null}

          <ListSection title={searching ? t("vault.results") : t("vault.allItems")}>
            {results.length === 0 ? (
              <p className="vault-empty">
                {searching ? t("vault.noResults") : t("vault.empty")}
              </p>
            ) : (
              <EntryList client={client} entries={results} />
            )}
          </ListSection>
        </div>
      )}
      </>}

      <UnlockedFooter
        onLock={onLock}
        onSignOut={onSignOut}
        onOpenSidePanel={onOpenSidePanel}
      />
    </section>
  );
}

function loadErrorKey(
  code: ReturnType<typeof useVaultList>["errorCode"],
  stage: ReturnType<typeof useVaultList>["decryptStage"],
): "vault.loadError" | "vault.loadErrorNetwork" | "vault.loadErrorDecrypt" | "vault.loadErrorVaultProjection" | "vault.loadErrorMemberIndex" | "vault.loadErrorSession" {
  if (code === "network") return "vault.loadErrorNetwork";
  if (stage === "vault-projection") return "vault.loadErrorVaultProjection";
  if (stage === "member-index") return "vault.loadErrorMemberIndex";
  if (code === "decrypt-failed") return "vault.loadErrorDecrypt";
  if (code === "locked" || code === "not-authenticated") return "vault.loadErrorSession";
  return "vault.loadError";
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
  onLock,
  onSignOut,
  onOpenSidePanel,
}: Pick<UnlockedScreenProps, "onLock" | "onSignOut" | "onOpenSidePanel">): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"lock" | "signout" | null>(null);

  async function run(kind: "lock" | "signout", action: () => Promise<void>): Promise<void> {
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
          {t("vault.openSidePanel")}
        </button>
      ) : (
        <button
          type="button"
          className="link-btn link-btn--palladin"
          onClick={() => chrome.tabs.create({ url: webAppUrl })}
        >
          <img className="footer-brand-logo" src={brandLogoUrl} alt="" aria-hidden="true" />
          {t("vault.openPalladin")}
        </button>
      )}
      <div className="vault-footer-actions">
        <Button
          variant="subtle"
          onClick={() => run("lock", onLock)}
          loading={busy === "lock"}
          disabled={busy !== null}
        >
          {t("vault.lock")}
        </Button>
        <Button
          variant="danger"
          onClick={() => run("signout", onSignOut)}
          loading={busy === "signout"}
          disabled={busy !== null}
        >
          {t("vault.signOut")}
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
