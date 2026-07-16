/**
 * The one and only persistence point for session state.
 *
 * SECURITY: keys live EXCLUSIVELY in `chrome.storage.session` — memory-backed,
 * never written to disk, and cleared when the browser closes. This module is the
 * single file allowed to touch a storage area, which keeps the "no
 * localStorage / IndexedDB / storage.local / storage.sync for keys" rule
 * auditable (a guard test greps the whole background tree). `storage.session`
 * survives a service-worker restart, so an already-unlocked session is restored
 * without re-deriving the master key.
 *
 * Keys are held as base64 strings on the wire because `chrome.storage`
 * serialisation does not preserve `Uint8Array` faithfully; the manager decodes
 * them straight back into buffers it owns and wipes. The tokens and account
 * material stored here are NOT vault key material (see the PR's refresh-token
 * rationale).
 */

import { fromBase64, toBase64 } from "@palladin/crypto";

import type { AutoLockPolicy } from "./auto-lock";
import type { AccountMaterial, SessionKeys, SessionTokens } from "./types";

/** Namespaced keys — one storage entry per concern so lock can drop just the keys. */
const KEY = {
  tokens: "palladin.session.tokens",
  material: "palladin.session.material",
  keys: "palladin.session.keys",
  autoLock: "palladin.session.autolock",
} as const;

interface PersistedKeys {
  readonly masterKey: string;
  readonly privateKey: string;
}

export interface AutoLockRecord {
  readonly policy: AutoLockPolicy;
  readonly lastActivityAt: number;
}

/**
 * Promise-based subset of `chrome.storage.StorageArea` (the shape of
 * `chrome.storage.session` in MV3). Injected so tests supply an in-memory fake.
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class SessionStore {
  constructor(private readonly area: StorageArea) {}

  private async read<T>(key: string): Promise<T | null> {
    const result = await this.area.get([key]);
    return (result[key] as T | undefined) ?? null;
  }

  async getTokens(): Promise<SessionTokens | null> {
    return this.read<SessionTokens>(KEY.tokens);
  }

  async setTokens(tokens: SessionTokens): Promise<void> {
    await this.area.set({ [KEY.tokens]: tokens });
  }

  async getMaterial(): Promise<AccountMaterial | null> {
    return this.read<AccountMaterial>(KEY.material);
  }

  async setMaterial(material: AccountMaterial): Promise<void> {
    await this.area.set({ [KEY.material]: material });
  }

  /** Decode the persisted keys into fresh buffers the caller owns and must wipe. */
  async getKeys(): Promise<SessionKeys | null> {
    const persisted = await this.read<PersistedKeys>(KEY.keys);
    if (!persisted) return null;
    return {
      masterKey: fromBase64(persisted.masterKey),
      privateKey: fromBase64(persisted.privateKey),
    };
  }

  async setKeys(keys: SessionKeys): Promise<void> {
    await this.area.set({
      [KEY.keys]: {
        masterKey: toBase64(keys.masterKey),
        privateKey: toBase64(keys.privateKey),
      } satisfies PersistedKeys,
    });
  }

  /** Drop only the key material (lock) — tokens and account material stay. */
  async clearKeys(): Promise<void> {
    await this.area.remove([KEY.keys]);
  }

  async getAutoLock(): Promise<AutoLockRecord | null> {
    return this.read<AutoLockRecord>(KEY.autoLock);
  }

  async setAutoLock(record: AutoLockRecord): Promise<void> {
    await this.area.set({ [KEY.autoLock]: record });
  }

  /** Wipe every session entry (logout). */
  async clearAll(): Promise<void> {
    await this.area.remove([KEY.tokens, KEY.material, KEY.keys, KEY.autoLock]);
  }
}
