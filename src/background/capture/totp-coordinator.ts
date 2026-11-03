import { capturedTotpIdentity, parseCapturedTotp } from '@shared/totp-capture';
import type { CapturedTotp, TotpWriteTarget } from '../vault/protocol2/credential-writer';
import type { SecretCaptureSource } from './secret-coordinator';

interface Session { profileId: string; generation: number; unlocked: boolean }
interface Deps {
  session(): Promise<Session | null>;
  current(source: SecretCaptureSource): Promise<boolean>;
  sourceMatches(source: SecretCaptureSource, expected: CapturedTotp): Promise<boolean>;
  activeTabId(): Promise<number | null>;
  choices(url: string): Promise<TotpWriteTarget[]>;
  save(totp: CapturedTotp, url: string, target: TotpWriteTarget, authorized: () => Promise<boolean>, create?: { label: string; username: string }): Promise<unknown>;
  invalidated?(): void;
  now?: () => number;
  createId?: () => string;
}
interface Pending {
  id: string; source: SecretCaptureSource; session: Session; totp: CapturedTotp; expires: number;
  targets: Map<string, TotpWriteTarget>; loaded: boolean; loading: Promise<boolean> | null; saving: boolean;
}
export class TotpCaptureCoordinator {
  private readonly pending = new Map<number, Pending>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly createId: () => string;
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now; this.createId = deps.createId ?? (() => crypto.randomUUID()); }
  clear(): void { for (const tabId of this.pending.keys()) this.clearTab(tabId); }
  clearDocument(tabId: number, browserDocumentId: string): boolean {
    return this.pending.get(tabId)?.source.browserDocumentId === browserDocumentId && this.clearTab(tabId);
  }
  clearTab(tabId: number): boolean { const removed = this.pending.delete(tabId); const timer = this.timers.get(tabId); if (timer) clearTimeout(timer); this.timers.delete(tabId); return removed; }
  async observe(uri: string, source: SecretCaptureSource, initiatingSessionCurrent: () => boolean = () => true): Promise<{ status: 'accepted'; id: string } | { status: 'invalid' | 'stale' }> {
    if (source.frameId !== 0 || source.browserDocumentId !== source.topDocumentId || !source.url.startsWith('https://')) return { status: 'stale' };
    const parsed = parseCapturedTotp(uri);
    if (!parsed || (parsed.digits !== 6 && parsed.digits !== 8)) return { status: 'invalid' };
    const session = await this.deps.session();
    if (!initiatingSessionCurrent() || !session?.unlocked || !(await this.deps.current(source))) return { status: 'stale' };
    const current = await this.deps.session();
    if (!initiatingSessionCurrent() || !current?.unlocked || current.generation !== session.generation || current.profileId !== session.profileId) return { status: 'stale' };
    const totp: CapturedTotp = { ...parsed, digits: parsed.digits as 6 | 8, issuer: parsed.issuer ?? null, account: parsed.account ?? null };
    const existing = this.pending.get(source.tabId);
    if (existing && existing.expires > this.now() && existing.source.browserDocumentId === source.browserDocumentId
      && existing.session.generation === session.generation && capturedTotpIdentity(existing.totp) === capturedTotpIdentity(totp)) return { status: 'accepted', id: existing.id };
    if (this.pending.size >= 8 && !existing) this.clearTab(this.pending.keys().next().value!);
    this.clearTab(source.tabId);
    const pending: Pending = { id: this.createId(), source, session, totp, expires: this.now() + 180_000, targets: new Map(), loaded: false, loading: null, saving: false };
    this.pending.set(source.tabId, pending);
    const tabId = source.tabId, id = pending.id;
    this.timers.set(tabId, setTimeout(() => { if (this.pending.get(tabId)?.id === id) { this.clearTab(tabId); this.deps.invalidated?.(); } }, 180_000));
    return { status: 'accepted', id: pending.id };
  }
  private async valid(p: Pending): Promise<boolean> {
    const session = await this.deps.session();
    return this.pending.get(p.source.tabId) === p && p.expires > this.now() && !!session?.unlocked
      && session.profileId === p.session.profileId && session.generation === p.session.generation
      && await this.deps.current(p.source) && this.pending.get(p.source.tabId) === p;
  }
  async review() {
    const tab = await this.deps.activeTabId(); const p = tab === null ? undefined : this.pending.get(tab);
    if (!p || !(await this.valid(p))) return { status: 'empty' as const };
    if (!p.loaded) {
      if (!p.loading) p.loading = (async () => {
        const targets = await this.deps.choices(p.source.url);
        if (!(await this.valid(p))) return false;
        p.targets = new Map(targets.map(target => [this.createId(), target])); p.loaded = true;
        return true;
      })();
      try { if (!(await p.loading)) return { status: 'empty' as const }; }
      finally { p.loading = null; }
    }
    const targets = [...p.targets].map(([id, target]) => ({ id, action: target.action, label: target.label,
      vaultLabel: target.vaultLabel, hasTotp: target.action === 'update' && target.hasTotp }));
    const updates = targets.filter(target => target.action === 'update');
    return { status: 'ready' as const, id: p.id, origin: new URL(p.source.url).origin,
      issuer: safeHint(p.totp.issuer, p.totp.secret), account: safeHint(p.totp.account, p.totp.secret), targets, defaultTargetId: updates.length === 1 ? updates[0]!.id : null };
  }
  async save(id: string, targetId: string, replace: boolean, create?: { label: string; username: string }) {
    const tab = await this.deps.activeTabId(); const p = tab === null ? undefined : this.pending.get(tab);
    if (!p || p.id !== id || !(await this.valid(p))) return { status: 'stale' as const };
    const target = p.targets.get(targetId);
    if (!target || !p.loaded || p.saving) return { status: 'stale' as const };
    if (target.action === 'update' && target.hasTotp && !replace) return { status: 'confirmation-required' as const };
    if (target.action === 'create' && (!create || !create.label.trim() || create.label.length > 512 || create.username.length > 512)) return { status: 'invalid' as const };
    p.saving = true;
    const authorized = async () => {
      if (!(await this.valid(p))) return false;
      if (!(await this.deps.sourceMatches(p.source, p.totp))) {
        if (this.pending.get(p.source.tabId) === p) { this.clearTab(p.source.tabId); this.deps.invalidated?.(); }
        return false;
      }
      return this.valid(p);
    };
    try {
      if (!(await authorized())) return { status: 'stale' as const };
      await this.deps.save(p.totp, p.source.url, target, authorized, create);
      if (this.pending.get(p.source.tabId) === p) this.clearTab(p.source.tabId);
      return { status: 'saved' as const };
    } catch { return await this.valid(p) ? { status: 'error' as const } : { status: 'stale' as const }; }
    finally { p.saving = false; }
  }
  async dismiss(id: string): Promise<void> {
    const tab = await this.deps.activeTabId(); if (tab !== null && this.pending.get(tab)?.id === id) this.clearTab(tab);
  }
}

function safeHint(value: string | null, secret: string): string | null {
  if (!value || value.toUpperCase().replace(/[^A-Z2-7]/g, '').includes(secret.replace(/=+$/, ''))) return null;
  return value.slice(0, 256);
}
