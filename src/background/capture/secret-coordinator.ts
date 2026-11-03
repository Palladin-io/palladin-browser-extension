import { registrableDomain } from '@shared/security/domain';
import type { SecretCandidate } from '@shared/messaging/secret-capture';
import type { ManualEntrySaveInput, ManualEntrySaveResult } from '../vault/protocol2/service';

export interface SecretCaptureSource {
  tabId: number; frameId: number; browserDocumentId: string; topDocumentId: string;
  documentId: string; url: string;
}
export interface SecretCaptureVault { id: string; name: string; isDefault: boolean }
interface CaptureSession { profileId: string; generation: number; unlocked: boolean }
interface Pending {
  id: string; candidate: SecretCandidate; source: SecretCaptureSource; session: CaptureSession;
  expires: number; busy: boolean; dismissed?: boolean; reviewed?: boolean;
}
interface Deps {
  now?(): number;
  session(): Promise<CaptureSession | null>;
  current(source: SecretCaptureSource): Promise<boolean>;
  activeTabId(): Promise<number | null>;
  muted(profileId: string, site: string): Promise<boolean>;
  mute(profileId: string, site: string): Promise<void>;
  vaults(): Promise<readonly SecretCaptureVault[]>;
  duplicate(entry: ManualEntrySaveInput, vaultId: string): Promise<boolean>;
  save(entry: ManualEntrySaveInput, vaultId: string, authorized: () => Promise<boolean>, current: () => boolean): Promise<ManualEntrySaveResult>;
}
export type SecretCaptureResult =
  | { status: 'accepted'; id: string }
  | { status: 'review'; id: string; candidate: SecretCandidate; origin: string; vaults: readonly SecretCaptureVault[] }
  | { status: 'empty' | 'stale' | 'locked' | 'muted' | 'full' | 'busy' | 'error' | 'saved' | 'duplicate' | 'dismissed' };

export class SecretCaptureCoordinator {
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tabEpochs = new Map<number, symbol>();
  private readonly now: () => number;
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now; }
  clear(): void {
    this.generation++; this.pending.clear(); this.tabEpochs.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  private remove(id: string): void {
    this.pending.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id);
  }
  clearTab(tabId: number): string[] {
    this.tabEpochs.set(tabId, Symbol());
    const ids = [...this.pending.values()].filter(item => item.source.tabId === tabId).map(item => item.id);
    for (const id of ids) this.remove(id);
    return ids;
  }
  disconnected(tabId: number, documentId: string): string[] {
    this.tabEpochs.set(tabId, Symbol());
    const ids = [...this.pending.values()].filter(item => item.source.tabId === tabId
      && (item.source.browserDocumentId === documentId || item.source.topDocumentId === documentId)).map(item => item.id);
    for (const id of ids) this.remove(id);
    return ids;
  }
  removedTab(tabId: number): string[] {
    const ids = this.clearTab(tabId); this.tabEpochs.delete(tabId);
    return ids;
  }
  private prune(): void {
    for (const item of this.pending.values()) if (item.expires <= this.now()) this.remove(item.id);
  }
  private async authorized(item: Pending, generation: number, active = false): Promise<boolean> {
    const session = await this.deps.session();
    if (!session?.unlocked || session.profileId !== item.session.profileId || session.generation !== item.session.generation) return false;
    if (await this.deps.muted(item.session.profileId, registrableDomain(item.source.url) ?? new URL(item.source.url).hostname)) return false;
    if (active && await this.deps.activeTabId() !== item.source.tabId || !await this.deps.current(item.source)) return false;
    return this.generation === generation && this.pending.get(item.id) === item && item.expires > this.now() && !item.dismissed;
  }
  async observe(candidate: SecretCandidate, source: SecretCaptureSource): Promise<SecretCaptureResult> {
    this.prune(); const generation = this.generation; const tabEpoch = this.tabEpochs.get(source.tabId) ?? Symbol();
    this.tabEpochs.set(source.tabId, tabEpoch);
    const session = await this.deps.session();
    if (!session?.unlocked) return { status: 'locked' };
    if (!await this.deps.current(source)) return { status: 'stale' };
    if (await this.deps.muted(session.profileId, registrableDomain(source.url) ?? new URL(source.url).hostname)) return { status: 'muted' };
    if (!await this.deps.current(source)) return { status: 'stale' };
    const after = await this.deps.session();
    if (generation !== this.generation || this.tabEpochs.get(source.tabId) !== tabEpoch || !after?.unlocked || session.generation !== after.generation || session.profileId !== after.profileId) return { status: 'stale' };
    const existing = [...this.pending.values()].find(item => item.source.tabId === source.tabId
      && item.source.browserDocumentId === source.browserDocumentId && item.source.documentId === source.documentId
      && (candidate.kind === 'card' && item.candidate.kind === 'card' && candidate.scopeId !== undefined
        ? item.candidate.scopeId === candidate.scopeId && item.candidate.cardNumber === candidate.cardNumber
        : JSON.stringify(item.candidate) === JSON.stringify(candidate)));
    if (existing && !existing.reviewed && !existing.dismissed) existing.candidate = { ...candidate };
    if (existing) return existing.dismissed ? { status: 'muted' } : { status: 'accepted', id: existing.id };
    if (this.pending.size >= 8) return { status: 'full' };
    const item: Pending = { id: crypto.randomUUID(), candidate: { ...candidate }, source: { ...source }, session,
      expires: this.now() + 180_000, busy: false };
    this.pending.set(item.id, item);
    this.timers.set(item.id, setTimeout(() => this.remove(item.id), 180_000));
    return { status: 'accepted', id: item.id };
  }
  async contentStatus(source: SecretCaptureSource, dismissId?: string): Promise<SecretCaptureResult> {
    this.prune();
    if (!(await this.deps.session())?.unlocked) return { status: 'locked' };
    for (const item of this.pending.values()) {
      if (item.dismissed || dismissId !== undefined && item.id !== dismissId) continue;
      if (item.source.tabId !== source.tabId || item.source.browserDocumentId !== source.browserDocumentId || item.source.documentId !== source.documentId) continue;
      if (!await this.authorized(item, this.generation)) return { status: 'stale' };
      if (dismissId === item.id) { item.dismissed = true; return { status: 'dismissed' }; }
      return { status: 'accepted', id: item.id };
    }
    return { status: 'empty' };
  }
  review(): Promise<SecretCaptureResult> { return this.readReview(); }
  beginReview(id: string): Promise<SecretCaptureResult> { return this.readReview(id); }
  private async readReview(selectedId?: string): Promise<SecretCaptureResult> {
    this.prune(); const generation = this.generation; const tab = await this.deps.activeTabId();
    for (const item of this.pending.values()) {
      if (item.dismissed || item.source.tabId !== tab || selectedId !== undefined && item.id !== selectedId) continue;
      if (!await this.authorized(item, generation, true)) { this.remove(item.id); continue; }
      try {
        const vaults = await this.deps.vaults();
        if (!await this.authorized(item, generation, true)) return { status: 'stale' };
        if (selectedId !== undefined) item.reviewed = true;
        return { status: 'review', id: item.id, candidate: { ...item.candidate }, origin: new URL(item.source.url).origin, vaults };
      } catch { return { status: 'error' }; }
    }
    return { status: 'empty' };
  }
  async dismiss(id: string, mute = false): Promise<SecretCaptureResult> {
    const item = this.pending.get(id); if (item) item.dismissed = true;
    if (mute && item && await this.sameSession(item)) await this.deps.mute(item.session.profileId, registrableDomain(item.source.url) ?? new URL(item.source.url).hostname);
    return { status: 'dismissed' };
  }
  private async sameSession(item: Pending): Promise<boolean> {
    const session = await this.deps.session();
    return !!session?.unlocked && session.profileId === item.session.profileId && session.generation === item.session.generation;
  }
  async save(id: string, vaultId: string, entry: ManualEntrySaveInput): Promise<SecretCaptureResult> {
    this.prune(); const item = this.pending.get(id); const generation = this.generation;
    if (!item || item.dismissed) return { status: 'stale' };
    if (item.busy) return { status: 'busy' };
    item.busy = true;
    const authorized = () => this.authorized(item, generation, true);
    try {
      if (!await authorized()) return { status: 'stale' };
      if (entry.entryType !== (item.candidate.kind === 'key' ? 'key' : 'creditCard')) return { status: 'stale' };
      if (!(await this.deps.vaults()).some(vault => vault.id === vaultId) || !await authorized()) return { status: 'stale' };
      if (await this.deps.duplicate(entry, vaultId)) {
        if (!await authorized()) return { status: 'stale' };
        item.dismissed = true; return { status: 'duplicate' };
      }
      if (!await authorized()) return { status: 'stale' };
      const result = await this.deps.save(entry, vaultId, authorized, () => this.generation === generation && this.pending.get(id) === item && !item.dismissed && item.expires > this.now());
      if (result.status !== 'saved') return { status: 'error' };
      item.dismissed = true; return { status: 'saved' };
    } catch { return { status: await authorized() ? 'error' : 'stale' }; }
    finally { item.busy = false; }
  }
}
