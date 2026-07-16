/**
 * Thin REST client for the vault + entry endpoints the service worker needs to
 * build its local metadata cache and to fetch a single entry's ciphertext on
 * demand. It speaks the same contract as the web panel's `vault-api` (cursor
 * pagination, `type` serialised as a camelCase string) but carries the
 * extension's own session JWT.
 *
 * `fetch` is injected so the whole client is testable against a mock backend
 * with no network. Nothing here decrypts: it only ever reads back metadata,
 * the wrapped Vault Key (ciphertext), and an entry's encrypted content.
 */

import { normalizeEntryType, type EntryTypeWire } from "./entry-metadata";

/** Typed failures so the data service can react (refresh on 401) without string-matching. */
export type VaultClientErrorCode = "unauthorized" | "network";

export class VaultClientError extends Error {
  constructor(
    readonly code: VaultClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultClientError";
  }
}

/** `GET /api/vaults` item — metadata only (no wrapped key). */
export interface VaultSummaryWire {
  readonly id: string;
  readonly name: string;
}

/** `GET /api/vaults/{id}` — we read only the caller's wrapped Vault Key. */
export interface VaultDetailWire {
  readonly id: string;
  /** base64 `crypto_box_seal(VK, userPublicKey)`; absent on legacy builds. */
  readonly wrappedVK?: string;
}

/** `GET /api/vaults/{id}/entries` item — discovery metadata, never a secret. */
export interface EntryListItemWire {
  readonly id: string;
  readonly label: string;
  readonly type: EntryTypeWire;
  readonly icon?: string;
  readonly color?: string;
  readonly urlDomain?: string;
  readonly updatedAt: string;
}

export interface EntryListPageWire {
  readonly items: readonly EntryListItemWire[];
  readonly nextCursor?: string;
}

/** Encrypted entry content — the (encryptedBlob, nonce) pair sealed under VK. */
export interface EntryContentWire {
  readonly encryptedBlob: string;
  readonly nonce: string;
}

/** `GET /api/vaults/{id}/entries/{eid}` — full detail, carries the ciphertext. */
export interface EntryDetailWire {
  readonly id: string;
  readonly type: EntryTypeWire;
  readonly content: EntryContentWire;
}

export type FetchLike = typeof fetch;

export class VaultClient {
  constructor(
    private readonly doFetch: FetchLike,
    private readonly apiUrl: string,
  ) {}

  private async getJson<T>(path: string, accessToken: string): Promise<T> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.apiUrl}${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new VaultClientError("network", `Request to ${path} failed`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new VaultClientError("unauthorized", `Auth rejected at ${path}`);
    }
    if (!response.ok) {
      throw new VaultClientError("network", `${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async listVaults(accessToken: string): Promise<VaultSummaryWire[]> {
    const body = await this.getJson<{ vaults: VaultSummaryWire[] }>("/api/vaults", accessToken);
    return body.vaults ?? [];
  }

  getVault(accessToken: string, vaultId: string): Promise<VaultDetailWire> {
    return this.getJson<VaultDetailWire>(`/api/vaults/${vaultId}`, accessToken);
  }

  listEntries(
    accessToken: string,
    vaultId: string,
    cursor?: string,
  ): Promise<EntryListPageWire> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.getJson<EntryListPageWire>(
      `/api/vaults/${vaultId}/entries${query}`,
      accessToken,
    );
  }

  /** Follow the cursor to the last page so no entry is silently missed. */
  async listAllEntries(
    accessToken: string,
    vaultId: string,
  ): Promise<EntryListItemWire[]> {
    const all: EntryListItemWire[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listEntries(accessToken, vaultId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  getEntry(
    accessToken: string,
    vaultId: string,
    entryId: string,
  ): Promise<EntryDetailWire> {
    return this.getJson<EntryDetailWire>(
      `/api/vaults/${vaultId}/entries/${entryId}`,
      accessToken,
    );
  }
}

export { normalizeEntryType };
