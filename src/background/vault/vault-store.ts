/**
 * Persistence for the vault data cache — metadata plus the wrapped Vault Keys —
 * in `chrome.storage.session` (memory-backed, cleared when the browser closes),
 * the same sanctioned area the session keys use.
 *
 * SECURITY: everything stored here is non-secret. `EntryMetadata` is
 * discovery-level data (label, domain, type); a wrapped VK is ciphertext
 * (`crypto_box_seal(VK, userPublicKey)`) that only the user's private key can
 * open. No plaintext secret, no unwrapped key, ever reaches this store — those
 * live only transiently in worker memory during a reveal/fill. Storing the cache
 * lets an already-open popup render instantly after a service-worker restart.
 */

import type { StorageArea } from "../session/session-store";
import type { EntryMetadata } from "./entry-metadata";

const KEY = {
  metadata: "palladin.vault.metadata",
  wrappedKeys: "palladin.vault.wrappedKeys",
} as const;

/** Wrapped Vault Key per vault id (base64 sealed box). Ciphertext only. */
export type WrappedKeyMap = Readonly<Record<string, string>>;

export class VaultStore {
  constructor(private readonly area: StorageArea) {}

  private async read<T>(key: string): Promise<T | null> {
    const result = await this.area.get([key]);
    return (result[key] as T | undefined) ?? null;
  }

  async getMetadata(): Promise<EntryMetadata[]> {
    return (await this.read<EntryMetadata[]>(KEY.metadata)) ?? [];
  }

  async setMetadata(entries: readonly EntryMetadata[]): Promise<void> {
    await this.area.set({ [KEY.metadata]: entries });
  }

  async getWrappedKeys(): Promise<WrappedKeyMap> {
    return (await this.read<WrappedKeyMap>(KEY.wrappedKeys)) ?? {};
  }

  async setWrappedKeys(keys: WrappedKeyMap): Promise<void> {
    await this.area.set({ [KEY.wrappedKeys]: keys });
  }

  /** Wipe the whole cache (lock/logout, or a failed sync that must not serve stale data). */
  async clear(): Promise<void> {
    await this.area.remove([KEY.metadata, KEY.wrappedKeys]);
  }
}
