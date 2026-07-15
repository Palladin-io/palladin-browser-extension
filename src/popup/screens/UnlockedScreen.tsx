import { useMemo, useState } from "react";

import { Button } from "../components/Button";
import { EntryList } from "../components/EntryList";
import { ListSkeleton } from "../components/ListSkeleton";
import { SearchBar } from "../components/SearchBar";
import { createVaultClient, type VaultClient } from "../vault/client";
import { filterEntries } from "../vault/filter";
import { useVaultList } from "../vault/useVaultList";
import { webAppUrl } from "@shared/config/web-app";

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
  /** Injected in tests; defaults to the real `chrome.runtime` vault channel. */
  vaultClient?: VaultClient;
}

export function UnlockedScreen({
  onLock,
  onSignOut,
  vaultClient,
}: UnlockedScreenProps): React.JSX.Element {
  const client = useMemo(() => vaultClient ?? createVaultClient(), [vaultClient]);
  const list = useVaultList(client);
  const [query, setQuery] = useState("");

  const searching = query.trim().length > 0;
  const results = useMemo(() => filterEntries(list.all, query), [list.all, query]);

  return (
    <section className="vault">
      <h2 className="sr-only">Your vault</h2>
      <SearchBar value={query} onChange={setQuery} />

      {list.status === "loading" ? (
        <ListSkeleton />
      ) : list.status === "error" ? (
        <p className="vault-error" role="alert">
          Couldn't load your entries. Open the popup again to retry.
        </p>
      ) : (
        <div className="vault-scroll">
          {!searching && list.forSite.length > 0 ? (
            <ListSection title="For this site">
              <EntryList client={client} entries={list.forSite} />
            </ListSection>
          ) : null}

          <ListSection title={searching ? "Results" : "All items"}>
            {results.length === 0 ? (
              <p className="vault-empty">
                {searching ? "No entries match your search." : "No entries yet."}
              </p>
            ) : (
              <EntryList client={client} entries={results} />
            )}
          </ListSection>
        </div>
      )}

      <UnlockedFooter onLock={onLock} onSignOut={onSignOut} />
    </section>
  );
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
}: Pick<UnlockedScreenProps, "onLock" | "onSignOut">): React.JSX.Element {
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
      <button
        type="button"
        className="link-btn"
        onClick={() => chrome.tabs.create({ url: webAppUrl })}
      >
        Open Palladin
      </button>
      <div className="vault-footer-actions">
        <Button
          variant="subtle"
          onClick={() => run("lock", onLock)}
          loading={busy === "lock"}
          disabled={busy !== null}
        >
          Lock
        </Button>
        <Button
          variant="danger"
          onClick={() => run("signout", onSignOut)}
          loading={busy === "signout"}
          disabled={busy !== null}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
