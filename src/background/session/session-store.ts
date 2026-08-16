/**
 * The one and only persistence point for session state.
 *
 * SECURITY: cryptographic keys never enter any extension storage. This store
 * contains only session tokens, opaque encrypted account material, and the
 * auto-lock policy. MK/private key stay in the live service-worker instance and
 * are lost when that worker is terminated. A restarted worker is therefore
 * locked and requires a fresh client-side derivation.
 */

import type { AutoLockPolicy } from "./auto-lock";
import type { AccountMaterial, SessionTokens } from "./types";

/** Namespaced keys — one storage entry per concern so lock can drop just the keys. */
const KEY = {
  tokens: "palladin.session.tokens",
  material: "palladin.session.material",
  autoLock: "palladin.session.autolock",
} as const;

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

  async getAutoLock(): Promise<AutoLockRecord | null> {
    return this.read<AutoLockRecord>(KEY.autoLock);
  }

  async setAutoLock(record: AutoLockRecord): Promise<void> {
    await this.area.set({ [KEY.autoLock]: record });
  }

  /** Wipe every session entry (logout). */
  async clearAll(): Promise<void> {
    await this.area.remove([KEY.tokens, KEY.material, KEY.autoLock]);
  }
}
