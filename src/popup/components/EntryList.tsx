/**
 * A list of entry rows with a simple cap + "Show more".
 *
 * Full virtualisation (react-window et al.) is not worth its weight in a 340px
 * popup that renders a handful of visible rows and collapses the rest behind
 * expandable drawers — it would add a dependency and complexity for no felt gain.
 * Capping the initial render at {@link CAP} and revealing the tail on demand
 * keeps the first paint cheap even for large vaults.
 */

import { useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { EntryRow } from "./EntryRow";
import { useI18n } from "../i18n";

export const CAP = 100;

export interface EntryListProps {
  client: VaultClient;
  entries: EntryMetadata[];
}

export function EntryList({ client, entries }: EntryListProps): React.JSX.Element {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? entries : entries.slice(0, CAP);
  const hidden = entries.length - visible.length;

  return (
    <div className="entry-list">
      {visible.map((entry) => (
        <EntryRow key={`${entry.vaultId}:${entry.id}`} client={client} entry={entry} />
      ))}
      {hidden > 0 ? (
        <button type="button" className="show-more" onClick={() => setShowAll(true)}>
          {t("vault.showMore", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
}
