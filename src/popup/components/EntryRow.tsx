/**
 * One entry in the popup list. Collapsed it shows the icon, name, and domain;
 * expanded it reveals the actions — Fill (credentials), copy buttons, the TOTP
 * code, and a deep link to the full entry in the web panel.
 *
 * Every secret-touching action is a deliberate click that asks the worker to
 * decrypt on demand (never on render, never in bulk). Fill goes through the
 * worker's gates and returns a value-free result the row surfaces inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import palladinIconUrl from "../../../icons/icon-32.png?inline";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { ENTRY_CREDIT_CARD, ENTRY_CREDENTIAL, ENTRY_KEY } from "../vault/entry-type";
import { entryDeepLink } from "@shared/config/web-app";
import { fillMessage } from "../vault/messages";
import { CopyButton } from "./CopyButton";
import { EntryIcon } from "./EntryIcon";
import { TotpBadge } from "./TotpBadge";
import { useI18n } from "../i18n";

export interface EntryRowProps {
  client: VaultClient;
  entry: EntryMetadata;
  grouped?: boolean;
  revealUsername?: boolean;
}

export function EntryRow({ client, entry, grouped = false, revealUsername = false }: EntryRowProps): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const isCredential = entry.type === ENTRY_CREDENTIAL;
  const isKey = entry.type === ENTRY_KEY;
  const isCard = entry.type === ENTRY_CREDIT_CARD;

  useEffect(() => {
    if ((!revealUsername && !open) || !isCredential) return;
    let active = true;
    void client.credentialUsername(entry.vaultId, entry.id)
      .then((value) => {
        if (active) setUsername(value);
      })
      .catch(() => {
        if (active) setUsername(null);
      });
    return () => {
      active = false;
    };
  }, [client, entry.id, entry.vaultId, isCredential, open, revealUsername]);

  const fill = useCallback(async () => {
    setStatus(t("fill.filling"));
    try {
      const result = await client.fill(entry.vaultId, entry.id);
      setStatus(fillMessage(result, t));
    } catch {
      setStatus(t("fill.error"));
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2500);
  }, [client, entry.vaultId, entry.id, t]);

  const login = useCallback(async () => {
    setStatus(t("fill.opening"));
    try {
      const result = await client.login(entry.vaultId, entry.id);
      setStatus(fillMessage(result, t));
    } catch {
      setStatus(t("fill.error"));
    }
  }, [client, entry.vaultId, entry.id, t]);

  const openInPanel = useCallback(() => {
    chrome.tabs.create({ url: entryDeepLink(entry.vaultId, entry.id) });
  }, [entry.vaultId, entry.id]);

  return (
    <div className={`entry-row${grouped ? " entry-row--grouped" : ""}`}>
      <button
        type="button"
        className="entry-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <EntryIcon
          name={entry.name}
          type={entry.type}
          {...(entry.icon ? { icon: entry.icon } : {})}
          {...(entry.color ? { color: entry.color } : {})}
        />
        <span className="entry-text">
          <span className="entry-name">{username || entry.name}</span>
          <span className="entry-sub">
            {username ? <span>{entry.name} · </span> : grouped ? null : entry.urlDomain ? <span>{entry.urlDomain} · </span> : null}
            <span>{t("vault.vaultName", { name: entry.vaultName })}</span>
          </span>
        </span>
        {isCard ? <span className="entry-tag">{t("vault.card")}</span> : null}
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
                {entry.urlDomain ? (
                  <button type="button" className="chip-btn chip-btn--accent entry-action-primary" onClick={() => void login()}>
                    {t("vault.logIn")}
                  </button>
                ) : null}
                <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="username" label={t("vault.copyUsername")} />
                <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="password" label={t("vault.copyPassword")} />
              </>
            ) : null}
            {isCard ? (
              <button type="button" className="chip-btn chip-btn--accent" onClick={() => void fill()}>
                {t("common.fill")}
              </button>
            ) : null}
            {isKey ? (
              <CopyButton client={client} vaultId={entry.vaultId} entryId={entry.id} field="value" label={t("vault.copyValue")} />
            ) : null}
          </div>

          {isCredential ? <TotpBadge client={client} vaultId={entry.vaultId} entryId={entry.id} /> : null}

          <div className="entry-manage-actions">
            <button type="button" className="chip-btn chip-btn--manage" onClick={openInPanel}>
              <img src={palladinIconUrl} alt="" aria-hidden="true" />
              {t("vault.openPanel")}
            </button>
          </div>

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
