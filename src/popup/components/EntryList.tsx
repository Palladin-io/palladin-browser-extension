import { usePopupView } from "../view/PopupView";
/** Progressively reveal Entry metadata without decrypting accounts. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { EntryRow } from "./EntryRow";
import { useI18n } from "../i18n";

export const CAP = 100;

export interface EntryListProps {
  client: VaultClient;
  entries: EntryMetadata[];
  priorityEntries?: readonly EntryMetadata[];
  selectedId?: string | undefined;
  onSelect?: ((entry: EntryMetadata) => void) | undefined;
}

export function EntryList({ client, entries, priorityEntries, selectedId, onSelect }: EntryListProps): React.JSX.Element {
  const { t } = useI18n();
  const navigation = usePopupView();
  const [localCount, setLocalCount] = useState(CAP);
  const visibleCount = navigation?.state.visibleCount ?? localCount;
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const items = useMemo(() => {
    const priority = new Set(priorityEntries?.map(entry => `${entry.vaultId}:${entry.id}`));
    const rank = (entry: EntryMetadata) => priority.has(`${entry.vaultId}:${entry.id}`) ? 0 : 1;
    return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [entries, priorityEntries]);
  const visible = items.slice(0, visibleCount);
  const hidden = items.length - visible.length;
  const showNext = useCallback(() => {
    const next = Math.max(CAP, Math.min(items.length, visibleCount + CAP));
    if (navigation) navigation.update({ visibleCount: next });
    else setLocalCount(next);
  }, [items.length, visibleCount, navigation]);

  useEffect(() => {
    setLocalCount(CAP);
  }, [entries]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (target === null || hidden <= 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((observations) => {
      if (observations.some((observation) => observation.isIntersecting)) showNext();
    }, { rootMargin: "120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hidden, showNext]);

  return (
    <div className="entry-list">
      {visible.map((entry) => (
        <EntryRow key={`${entry.vaultId}:${entry.id}`} client={client} entry={entry} selected={selectedId === `${entry.vaultId}:${entry.id}`} onSelect={onSelect} />
      ))}
      {hidden > 0 ? (
        <button ref={loadMoreRef} type="button" className="show-more" onClick={showNext}>
          {t("vault.showMore", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
}
