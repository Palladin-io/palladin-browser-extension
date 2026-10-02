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
  readonly pageRequestId: string;
  readonly source: ShareSource;
  readonly snapshot: ShareSnapshot;
  readonly keys: object;
  readonly userId: string;
  readonly preparedAt: number;
}

export class ShareSaveCoordinator {
  private pending: PendingShare | null = null;
  private lastOutcome: { source: ShareSource; requestId: string; status: 'cancelled' | 'saved'; at: number } | null = null;
  private committing = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: ShareSaveDeps) {}

  clear(): void {
    this.pending = null;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }
  private remember(status: 'cancelled' | 'saved', value: PendingShare): void {
    this.lastOutcome = { source: value.source, requestId: value.pageRequestId, status, at: this.deps.now() };
  }
  async reconcile(source: ShareSource, requestId: string): Promise<'pending' | 'cancelled' | 'saved' | 'unknown'> {
    if (source.apiUrl !== this.deps.apiUrl() || !await this.deps.currentSource(source)) return 'unknown';
    const sameSource = (other: ShareSource) => other.tabId === source.tabId && other.documentId === source.documentId
      && other.url === source.url && other.webOrigin === source.webOrigin && other.apiUrl === source.apiUrl;
    if (this.pending?.pageRequestId === requestId && sameSource(this.pending.source)) {
      try { this.assertCurrent(this.pending); return 'pending'; }
      catch { /* An expired or invalid confirmation is not pending. */ }
    }
    const result = this.lastOutcome;
    return result && result.requestId === requestId && sameSource(result.source)
      && this.deps.now() >= result.at && this.deps.now() - result.at <= 900_000 ? result.status : 'unknown';
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

  async prepare(source: ShareSource, snapshot: ShareSnapshot, pageRequestId: string = crypto.randomUUID()): Promise<'unavailable' | 'locked' | 'pending'> {
    if (this.committing) return 'unavailable';
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
    // Do not discard an existing confirmation when a replacement is rejected.
    this.clear();
    this.pending = { id: crypto.randomUUID(), pageRequestId, source, snapshot, keys, userId, preparedAt: this.deps.now() };
    const prepared = this.pending;
    this.expiry = setTimeout(() => {
      if (this.pending !== prepared) return;
      if (!this.committing) this.remember('cancelled', prepared);
      this.clear();
      this.deps.onExpired();
    }, 120_000);
    return 'pending';
  }

  private assertCurrent(value: PendingShare): void {
    const expired = this.deps.now() - value.preparedAt > 120_000;
    const wasCurrent = this.pending === value;
    if (!wasCurrent || expired
      || this.deps.now() < value.preparedAt || this.deps.keys() !== value.keys
      || this.deps.apiUrl() !== value.source.apiUrl) {
      this.clear();
      if (expired && wasCurrent && !this.committing) this.remember('cancelled', value);
      if (expired && wasCurrent) this.deps.onExpired();
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
    if (this.pending?.id === id && !this.committing) {
      this.remember('cancelled', this.pending);
      this.clear();
    }
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
      if (saved) this.remember('saved', value);
      return saved ? 'saved' : 'failed';
    } catch { return 'failed'; }
    finally { this.clear(); this.committing = false; }
  }
}
