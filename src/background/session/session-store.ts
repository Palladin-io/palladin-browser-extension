/**
 * The one and only persistence point for session state.
 *
 * SECURITY: cryptographic keys never enter any extension storage. This store
 * contains only a password-sealed durable-session envelope and the non-secret
 * auto-lock policy. MK/private key stay in the live service-worker instance and
 * are lost when that worker is terminated. Bearer tokens exist only in worker
 * memory or inside the authenticated ciphertext envelope.
 */

import {
  parseBrowserSessionEnvelope,
  type BrowserSessionEnvelope,
} from "@palladin/crypto";

import type { AutoLockPolicy } from "./auto-lock";

/** Namespaced keys - one storage entry per durable concern. */
const KEY = {
  sealedSession: "palladin.session.sealed.v1",
  autoLock: "palladin.session.autolock",
} as const;

/** Pre-sealed-session keys. They are deleted, never migrated or trusted. */
const LEGACY_KEY = {
  tokens: "palladin.session.tokens",
  material: "palladin.session.material",
  autoLock: "palladin.session.autolock",
  keys: "palladin.session.keys",
} as const;

export interface AutoLockRecord {
  readonly policy: AutoLockPolicy;
  readonly lastActivityAt: number;
}

/**
 * Promise-based subset of `chrome.storage.StorageArea`. Injected so tests
 * supply separate in-memory durable and legacy-session areas.
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class SessionStore {
  constructor(
    private readonly durableArea: StorageArea,
    private readonly legacySessionArea?: StorageArea,
  ) {}

  private async read<T>(key: string): Promise<T | null> {
    const result = await this.durableArea.get([key]);
    return (result[key] as T | undefined) ?? null;
  }

  async getSealedSession(): Promise<BrowserSessionEnvelope | null> {
    const candidate = await this.read<unknown>(KEY.sealedSession);
    if (candidate === null) return null;
    try {
      return parseBrowserSessionEnvelope(candidate);
    } catch {
      await this.durableArea.remove([KEY.sealedSession]);
      return null;
    }
  }

  async setSealedSession(envelope: BrowserSessionEnvelope): Promise<void> {
    const validated = parseBrowserSessionEnvelope(envelope);
    await this.durableArea.set({ [KEY.sealedSession]: validated });
  }

  async clearSealedSession(): Promise<void> {
    await this.durableArea.remove([KEY.sealedSession]);
  }

  async getAutoLock(): Promise<AutoLockRecord | null> {
    return this.read<AutoLockRecord>(KEY.autoLock);
  }

  async setAutoLock(record: AutoLockRecord): Promise<void> {
    await this.durableArea.set({ [KEY.autoLock]: record });
  }

  /** Delete every obsolete plaintext/session-only record without migrating it. */
  async clearLegacyPlaintext(): Promise<void> {
    if (!this.legacySessionArea) return;
    await this.legacySessionArea.remove(Object.values(LEGACY_KEY));
  }

  /** Wipe every session entry (logout). */
  async clearAll(): Promise<void> {
    await this.durableArea.remove([KEY.sealedSession, KEY.autoLock]);
    await this.clearLegacyPlaintext();
  }
}
