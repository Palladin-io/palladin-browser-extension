/**
 * One entry in the popup list. Collapsed it shows the icon, name, and domain;
 * expanded it reveals the actions — Fill (credentials), copy buttons, the TOTP
 * code, and a deep link to the full entry in the web panel.
 *
 * Every secret-touching action is a deliberate click that asks the worker to
 * decrypt on demand (never on render, never in bulk). Fill goes through the
 * worker's gates and returns a value-free result the row surfaces inline.
 */

import { useCallback, useRef, useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { ENTRY_CREDIT_CARD, ENTRY_CREDENTIAL, ENTRY_KEY } from "../vault/entry-type";
import { entryDeepLink } from "@shared/config/web-app";
import { fillMessage } from "../vault/messages";
import { CopyButton } from "./CopyButton";
import { EntryIcon } from "./EntryIcon";
import { TotpBadge } from "./TotpBadge";

export interface EntryRowProps {
  client: VaultClient;
  entry: EntryMetadata;
}

export function EntryRow({ client, entry }: EntryRowProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCredential = entry.type === ENTRY_CREDENTIAL;
  const isKey = entry.type === ENTRY_KEY;
  const isCard = entry.type === ENTRY_CREDIT_CARD;

  const fill = useCallback(async () => {
    setStatus("Filling…");
    try {
      const result = await client.fill(entry.vaultId, entry.id);
      setStatus(fillMessage(result));
    } catch {
      setStatus("Could not fill this entry");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2500);
  }, [client, entry.vaultId, entry.id]);

  const openInPanel = useCallback(() => {
    chrome.tabs.create({ url: entryDeepLink(entry.vaultId, entry.id) });
  }, [entry.vaultId, entry.id]);

  return (
    <div className="entry-row">
      <button
        type="button"
        className="entry-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <EntryIcon name={entry.name} {...(entry.color ? { color: entry.color } : {})} />
        <span className="entry-text">
          <span className="entry-name">{entry.name}</span>
          {entry.urlDomain ? <span className="entry-sub">{entry.urlDomain}</span> : null}
        </span>
        {isCredential ? <span className="entry-tag">Login</span> : null}
        {isCard ? <span className="entry-tag">Card</span> : null}
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
        <div className="entry-drawer">
          <div className="entry-actions">
            {isCredential ? (
              <>
                <button type="button" className="chip-btn chip-btn--accent" onClick={() => void fill()}>
                  Fill
                </button>
                <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="username" label="Copy username" />
                <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="password" label="Copy password" />
              </>
            ) : null}
            {isCard ? (
              <button type="button" className="chip-btn chip-btn--accent" onClick={() => void fill()}>
                Fill
              </button>
            ) : null}
            {isKey ? (
              <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="value" label="Copy value" />
            ) : null}
          </div>

          {isCredential ? <TotpBadge client={client} vaultId={entry.vaultId} entryId={entry.id} /> : null}

          <button type="button" className="link-btn" onClick={openInPanel}>
            Open in web panel
          </button>

          {status ? (
            <p className="entry-status" role="status">
              {status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
