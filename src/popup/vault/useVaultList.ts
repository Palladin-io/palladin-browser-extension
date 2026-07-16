/**
 * Loads the vault list for the unlocked popup and keeps it fresh.
 *
 * Two reads on open (plan §6 sync-on-popup-open): first `list()` returns the
 * cached metadata instantly so the list paints without waiting on the network,
 * then `sync()` refetches and replaces it. The skeleton shows only until the
 * first of the two resolves — the search bar and header stay visible throughout.
 */

import { useEffect, useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { SiteInfo } from "../../background/vault/commands";
import type { VaultClient } from "./client";

export type VaultListStatus = "loading" | "ready" | "error";

export interface VaultListState {
  status: VaultListStatus;
  site: SiteInfo | null;
  forSite: EntryMetadata[];
  all: EntryMetadata[];
}

const EMPTY: VaultListState = { status: "loading", site: null, forSite: [], all: [] };

export function useVaultList(client: VaultClient): VaultListState {
  const [state, setState] = useState<VaultListState>(EMPTY);

  useEffect(() => {
    let active = true;
    setState(EMPTY);
    void (async () => {
      try {
        const cached = await client.list();
        if (active) setState({ status: "ready", ...cached });
      } catch {
        // No cache yet — the sync below decides loading vs error.
      }
      try {
        const fresh = await client.sync();
        if (active) setState({ status: "ready", ...fresh });
      } catch {
        if (active) {
          setState((prev) =>
            prev.status === "loading" ? { ...EMPTY, status: "error" } : prev,
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return state;
}
