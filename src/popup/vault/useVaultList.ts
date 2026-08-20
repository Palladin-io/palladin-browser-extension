/**
 * Loads the vault list for the unlocked popup and keeps it fresh.
 *
 * Two reads on open (plan §6 sync-on-popup-open): first `list()` returns the
 * cached metadata instantly so a non-empty list paints without waiting on the
 * network, then `sync()` asks the worker to ensure freshness. The worker reuses
 * a recent authoritative refresh, so popup/side-panel remounts and page reloads
 * do not automatically hit the backend. An empty cache keeps the skeleton
 * visible until sync confirms the authoritative empty state. The search bar and
 * header stay visible throughout.
 */

import { useEffect, useState } from "react";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { SiteInfo, VaultCommandErrorCode } from "../../background/vault/commands";
import {
  VaultClientError,
  type VaultClient,
  type VaultDecryptFailureStage,
} from "./client";

export type VaultListStatus = "loading" | "ready" | "error";

export interface VaultListState {
  status: VaultListStatus;
  errorCode: VaultCommandErrorCode | null;
  decryptStage: VaultDecryptFailureStage | null;
  site: SiteInfo | null;
  forSite: EntryMetadata[];
  all: EntryMetadata[];
  retry(): void;
}

type StoredVaultListState = Omit<VaultListState, "retry">;

const EMPTY: StoredVaultListState = {
  status: "loading",
  errorCode: null,
  decryptStage: null,
  site: null,
  forSite: [],
  all: [],
};

export function useVaultList(client: VaultClient): VaultListState {
  const [state, setState] = useState<StoredVaultListState>(EMPTY);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState(EMPTY);
    void (async () => {
      let cached: StoredVaultListState | null = null;
      try {
        const list = await client.list();
        cached = { status: "ready", errorCode: null, decryptStage: null, ...list };
        // An empty local cache is not an authoritative empty Vault. Keep the
        // loading state until sync confirms that there really are no entries,
        // otherwise the popup briefly flashes "No entries yet" after sign-in
        // or unlock while the first server read is still in flight.
        const hasCachedEntries = list.all.length > 0 || list.forSite.length > 0;
        if (active && hasCachedEntries) setState(cached);
      } catch {
        // No cache yet — the sync below decides loading vs error.
      }
      try {
        const fresh = await client.sync();
        if (active) setState({ status: "ready", errorCode: null, decryptStage: null, ...fresh });
      } catch (error) {
        if (active) {
          // An empty cache is not evidence that the Vault is truly empty. If
          // the authoritative refresh failed, surface the failure instead of
          // presenting a misleading "No entries yet" state.
          const hasCachedEntries = cached !== null
            && (cached.all.length > 0 || cached.forSite.length > 0);
          if (!hasCachedEntries) {
            setState({
              ...EMPTY,
              status: "error",
              errorCode: error instanceof VaultClientError ? error.code : "network",
              decryptStage: error instanceof VaultClientError ? error.decryptStage : null,
            });
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt, client]);

  return { ...state, retry: () => setAttempt((current) => current + 1) };
}
