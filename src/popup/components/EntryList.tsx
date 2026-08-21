/**
 * A grouped list rendered in 100-item batches. The next batch is loaded when
 * its sentinel reaches the scroll viewport; the button remains a keyboard and
 * compatibility fallback when IntersectionObserver is unavailable.
 *
 * Full virtualisation (react-window et al.) is not worth its weight in a 340px
 * popup that renders a handful of visible rows and collapses the rest behind
 * expandable drawers — it would add a dependency and complexity for no felt gain.
 * Capping the initial render at {@link CAP} and revealing the tail on demand
 * keeps the first paint cheap even for large vaults.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { EntryIcon } from "./EntryIcon";
import { EntryRow } from "./EntryRow";
import { useI18n } from "../i18n";

export const CAP = 100;

export interface EntryListProps {
  client: VaultClient;
  entries: EntryMetadata[];
}

export function EntryList({ client, entries }: EntryListProps): React.JSX.Element {
  const { t } = useI18n();
  const [visibleCount, setVisibleCount] = useState(CAP);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const items = useMemo(() => groupEntriesByDomain(entries), [entries]);
  const visible = items.slice(0, visibleCount);
  const hidden = items.length - visible.length;
  const showNext = useCallback(() => {
    setVisibleCount((current) => Math.min(items.length, current + CAP));
  }, [items.length]);

  useEffect(() => {
    setVisibleCount(CAP);
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
      {visible.map((item) => item.kind === "entry" ? (
        <EntryRow key={`${item.entry.vaultId}:${item.entry.id}`} client={client} entry={item.entry} />
      ) : (
        <DomainEntryGroup key={item.domain} client={client} domain={item.domain} entries={item.entries} />
      ))}
      {hidden > 0 ? (
        <button ref={loadMoreRef} type="button" className="show-more" onClick={showNext}>
          {t("vault.showMore", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
}

interface DomainGroup {
  readonly kind: "domain";
  readonly domain: string;
  readonly entries: EntryMetadata[];
}

interface SingleEntry {
  readonly kind: "entry";
  readonly entry: EntryMetadata;
}

export type EntryListItem = DomainGroup | SingleEntry;

/**
 * Collapse repeated website rows into one domain cluster. Entries without a
 * website remain ordinary rows. Usernames stay encrypted until the user opens
 * a cluster; expanding it mounts the child rows which reveal only their own
 * username into this extension-owned surface.
 */
export function groupEntriesByDomain(entries: readonly EntryMetadata[]): EntryListItem[] {
  const byDomain = new Map<string, EntryMetadata[]>();
  const withoutDomain: EntryMetadata[] = [];

  for (const entry of entries) {
    const domain = entry.urlDomain?.trim().toLowerCase();
    if (!domain) {
      withoutDomain.push(entry);
      continue;
    }
    const group = byDomain.get(domain) ?? [];
    group.push(entry);
    byDomain.set(domain, group);
  }

  const domains: EntryListItem[] = [...byDomain.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, grouped]) => grouped.length === 1
      ? { kind: "entry", entry: grouped[0]! }
      : { kind: "domain", domain, entries: grouped });
  const singles: EntryListItem[] = withoutDomain
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ kind: "entry", entry }));
  return [...domains, ...singles];
}

function DomainEntryGroup({
  client,
  domain,
  entries,
}: {
  readonly client: VaultClient;
  readonly domain: string;
  readonly entries: EntryMetadata[];
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const sample = entries[0]!;

  return (
    <div className={`entry-domain-group${open ? " entry-domain-group--open" : ""}`}>
      <button
        type="button"
        className="entry-domain-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <EntryIcon
          name={domain}
          type={sample.type}
          {...(sample.icon ? { icon: sample.icon } : {})}
          {...(sample.color ? { color: sample.color } : {})}
        />
        <span className="entry-text">
          <span className="entry-name">{domain}</span>
          <span className="entry-sub">
            {t("vault.groupSummary", { entries: entries.length })}
          </span>
        </span>
        <svg
          className={`entry-chevron${open ? " entry-chevron--open" : ""}`}
          viewBox="0 0 20 20"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="entry-domain-children">
          {entries.map((entry) => (
            <EntryRow
              key={`${entry.vaultId}:${entry.id}`}
              client={client}
              entry={entry}
              grouped
              revealUsername
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
