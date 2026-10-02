import type { ShareSnapshot } from '../../shared/messaging/share-save';
import { sharedCopySecret } from '../vault/shared-copy';

export interface ShareSource {
  readonly tabId: number;
  readonly documentId: string;
  readonly url: string;
  readonly webOrigin: string;
  readonly apiUrl: string;
}

export interface ShareSaveDeps {
  now(): number;
  keys(): object | null;
  userId(): Promise<string | null>;
  apiUrl(): string;
  currentSource(source: ShareSource): Promise<boolean>;
  onExpired(): void;
  vaults(): Promise<readonly { id: string; name: string }[]>;
  canManage(): Promise<boolean>;
  save(snapshot: ShareSnapshot, vaultId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
}

interface PendingShare {
  readonly id: string;
  readonly source: ShareSource;
  readonly snapshot: ShareSnapshot;
  readonly keys: object;
  readonly userId: string;
  readonly preparedAt: number;
}

export class ShareSaveCoordinator {
  private pending: PendingShare | null = null;
  private committing = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: ShareSaveDeps) {}

  clear(): void {
    this.pending = null;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }
  clearTab(tabId: number): boolean {
    if (this.pending?.source.tabId !== tabId) return false;
    this.clear();
    return true;
  }
  clearDocument(tabId: number, documentId: string): boolean {
    if (this.pending?.source.tabId !== tabId || this.pending.source.documentId !== documentId) return false;
    this.clear();
    return true;
  }
  clearReplacedDocument(tabId: number, documentId: string): boolean {
    if (this.pending?.source.tabId !== tabId || this.pending.source.documentId === documentId) return false;
    this.clear();
    return true;
  }

  async status(source: ShareSource): Promise<'unavailable' | 'locked' | 'ready'> {
    if (!await this.deps.currentSource(source) || source.apiUrl !== this.deps.apiUrl()) return 'unavailable';
    if (!this.deps.keys() || !await this.deps.userId()) return 'locked';
    return await this.deps.canManage() ? 'ready' : 'unavailable';
  }

  async prepare(source: ShareSource, snapshot: ShareSnapshot): Promise<'unavailable' | 'locked' | 'pending'> {
    if (this.committing) return 'unavailable';
    this.clear();
    const status = await this.status(source);
    if (status !== 'ready') return status;
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 262_144) return 'unavailable';
    // Validate all fields before retaining any page plaintext. The canonical
    // conversion also rejects unsupported fields such as a key URL.
    try { sharedCopySecret(snapshot); } catch { return 'unavailable'; }
    if ((await this.deps.vaults()).length === 0) return 'unavailable';
    const keys = this.deps.keys();
    const userId = await this.deps.userId();
    if (!keys || !userId || !await this.deps.currentSource(source)) return 'unavailable';
    this.pending = { id: crypto.randomUUID(), source, snapshot, keys, userId, preparedAt: this.deps.now() };
    const prepared = this.pending;
    this.expiry = setTimeout(() => {
      if (this.pending !== prepared) return;
      this.clear();
      this.deps.onExpired();
    }, 120_000);
    return 'pending';
  }

  private assertCurrent(value: PendingShare): void {
    if (this.pending !== value || this.deps.now() - value.preparedAt > 120_000
      || this.deps.now() < value.preparedAt || this.deps.keys() !== value.keys
      || this.deps.apiUrl() !== value.source.apiUrl) {
      this.clear();
      throw new Error('Share handoff is no longer current');
    }
  }

  private async assertLive(value: PendingShare): Promise<void> {
    this.assertCurrent(value);
    if (await this.deps.userId() !== value.userId || !await this.deps.currentSource(value.source)
      || !await this.deps.canManage()) {
      this.clear();
      throw new Error('Share handoff is no longer current');
    }
    this.assertCurrent(value);
  }

  async view(): Promise<{ id: string; title: string; entryType: ShareSnapshot['entryType'];
    vaults: readonly { id: string; name: string }[] } | null> {
    const value = this.pending;
    if (!value) return null;
    try {
      this.assertCurrent(value);
      if (await this.deps.userId() !== value.userId || !await this.deps.currentSource(value.source)) {
        this.clear(); return null;
      }
      const vaults = await this.deps.vaults();
      this.assertCurrent(value);
      return { id: value.id, title: value.snapshot.title, entryType: value.snapshot.entryType, vaults };
    } catch { this.clear(); return null; }
  }

  cancel(id: string): void {
    if (this.pending?.id === id && !this.committing) this.clear();
  }

  async confirm(id: string, vaultId: string): Promise<'saved' | 'failed'> {
    const value = this.pending;
    if (!value || value.id !== id || this.committing) return 'failed';
    this.committing = true;
    try {
      await this.assertLive(value);
      const vaults = await this.deps.vaults();
      if (!vaults.some(vault => vault.id === vaultId)) return 'failed';
      this.assertCurrent(value);
      const saved = await this.deps.save(value.snapshot, vaultId, () => this.assertLive(value));
      return saved ? 'saved' : 'failed';
    } catch { return 'failed'; }
    finally { this.clear(); this.committing = false; }
  }
}
