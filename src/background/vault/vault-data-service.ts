/**
 * The service worker's vault data layer (plan §6 sync, §8 gates).
 *
 * Two jobs, kept apart on purpose:
 *   1. SYNC — pull vault + entry METADATA and the wrapped Vault Keys (ciphertext)
 *      after unlock / on popup open / on the alarm tick, and cache them. This
 *      touches no secret: it never decrypts.
 *   2. REVEAL — decrypt ONE entry on demand (a fill, a copy, a TOTP code). The
 *      plaintext is produced transiently in worker memory and returned to the
 *      caller; it is never written to storage and never logged. The Vault Key is
 *      unwrapped just for that entry and wiped immediately after.
 *
 * Everything Chrome/crypto-adjacent is injected (client, store, a
 * {@link SessionAccessor}) so the whole service is unit-testable against fakes
 * with real crypto fixtures.
 */

import { decryptEntry, unsealVaultKey, wipe, type EntryPlaintext } from "@palladin/crypto";

import { normalizeEntryType, type EntryMetadata } from "./entry-metadata";
import { VaultClient, VaultClientError } from "./vault-client";
import { VaultStore, type WrappedKeyMap } from "./vault-store";

/**
 * The slice of session state the data layer needs. The session module owns key
 * custody and token storage; this accessor is the read/refresh seam so the data
 * service never reaches into the manager's internals.
 */
export interface SessionAccessor {
  /** Current access token, or null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Refresh the access token (rotate), returning the new one or null on failure. */
  refreshAccessToken(): Promise<string | null>;
  /** The in-memory X25519 private key while unlocked, or null when locked. */
  getPrivateKey(): Uint8Array | null;
}

export type VaultDataErrorCode =
  | "locked"
  | "not-authenticated"
  | "no-vault-key"
  | "decrypt-failed"
  | "network";

export class VaultDataError extends Error {
  constructor(
    readonly code: VaultDataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultDataError";
  }
}

export interface VaultDataServiceDeps {
  client: VaultClient;
  store: VaultStore;
  session: SessionAccessor;
}

export class VaultDataService {
  private readonly client: VaultClient;
  private readonly store: VaultStore;
  private readonly session: SessionAccessor;

  constructor(deps: VaultDataServiceDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.session = deps.session;
  }

  // ─── Sync (metadata + wrapped keys, no decryption) ──────────────────────────

  /**
   * Refetch every vault's metadata and wrapped key and replace the cache. When
   * signed out, the cache is cleared instead. A single 401 triggers one token
   * refresh + retry; a persistent auth failure clears the cache and throws.
   */
  async refresh(): Promise<EntryMetadata[]> {
    const token = await this.session.getAccessToken();
    if (!token) {
      await this.store.clear();
      return [];
    }
    const { metadata, wrappedKeys } = await this.withAuth((accessToken) =>
      this.fetchAll(accessToken),
    );
    await this.store.setWrappedKeys(wrappedKeys);
    await this.store.setMetadata(metadata);
    return metadata;
  }

  private async fetchAll(
    accessToken: string,
  ): Promise<{ metadata: EntryMetadata[]; wrappedKeys: WrappedKeyMap }> {
    const vaults = await this.client.listVaults(accessToken);
    const metadata: EntryMetadata[] = [];
    const wrappedKeys: Record<string, string> = {};

    for (const vault of vaults) {
      const detail = await this.client.getVault(accessToken, vault.id);
      if (!detail.wrappedVK) continue;
      wrappedKeys[vault.id] = detail.wrappedVK;

      const items = await this.client.listAllEntries(accessToken, vault.id);
      for (const item of items) {
        metadata.push({
          id: item.id,
          vaultId: vault.id,
          name: item.label,
          type: normalizeEntryType(item.type),
          updatedAt: item.updatedAt,
          ...(item.urlDomain ? { urlDomain: item.urlDomain } : {}),
          ...(item.icon ? { icon: item.icon } : {}),
          ...(item.color ? { color: item.color } : {}),
        });
      }
    }
    return { metadata, wrappedKeys };
  }

  getMetadata(): Promise<EntryMetadata[]> {
    return this.store.getMetadata();
  }

  /** Drop the cached metadata + wrapped keys (on sign-out). */
  clearCache(): Promise<void> {
    return this.store.clear();
  }

  // ─── Reveal (decrypt one entry on demand) ───────────────────────────────────

  /**
   * Decrypt a single entry and return its plaintext. The caller (a fill, copy,
   * or TOTP command) uses the value transiently and lets it go — this service
   * never persists or logs it. Throws {@link VaultDataError} `locked` when the
   * session has no keys, so the popup can prompt an unlock instead of failing
   * opaquely.
   */
  async revealEntry(vaultId: string, entryId: string): Promise<EntryPlaintext> {
    const privateKey = this.session.getPrivateKey();
    if (!privateKey) {
      throw new VaultDataError("locked", "Session is locked");
    }
    const wrappedVK = (await this.store.getWrappedKeys())[vaultId];
    if (!wrappedVK) {
      throw new VaultDataError("no-vault-key", "No wrapped vault key cached");
    }

    const detail = await this.withAuth((token) =>
      this.client.getEntry(token, vaultId, entryId),
    );

    let vaultKey: Uint8Array | null = null;
    try {
      vaultKey = await unsealVaultKey(wrappedVK, privateKey);
      return await decryptEntry(detail.content, vaultKey);
    } catch (error) {
      if (error instanceof VaultDataError) throw error;
      // A MAC failure or malformed blob — never surface the underlying value.
      throw new VaultDataError("decrypt-failed", "Failed to decrypt entry");
    } finally {
      if (vaultKey) wipe(vaultKey);
    }
  }

  // ─── Auth helper ────────────────────────────────────────────────────────────

  /**
   * Run an authorised call, refreshing the token once on a 401 and retrying.
   * A network error propagates as {@link VaultDataError} `network`; a persistent
   * auth failure as `not-authenticated`.
   */
  private async withAuth<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.session.getAccessToken();
    if (!token) throw new VaultDataError("not-authenticated", "No session");
    try {
      return await fn(token);
    } catch (error) {
      if (error instanceof VaultClientError && error.code === "unauthorized") {
        const refreshed = await this.session.refreshAccessToken();
        if (!refreshed) throw new VaultDataError("not-authenticated", "Session expired");
        try {
          return await fn(refreshed);
        } catch (retryError) {
          throw this.mapClientError(retryError);
        }
      }
      throw this.mapClientError(error);
    }
  }

  private mapClientError(error: unknown): VaultDataError {
    if (error instanceof VaultDataError) return error;
    if (error instanceof VaultClientError) {
      return error.code === "unauthorized"
        ? new VaultDataError("not-authenticated", "Session expired")
        : new VaultDataError("network", "Vault request failed");
    }
    return new VaultDataError("network", "Vault request failed");
  }
}
