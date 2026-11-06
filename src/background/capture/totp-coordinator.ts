import { captureDocumentKey, captureTopDocumentKey } from './document-identity';
import type { CaptureNoticeIdentity } from '@shared/messaging/capture-notice';
import type { TotpEntryRef } from '@shared/messaging/totp-capture';
import { capturedTotpIdentity, parseCapturedTotp } from '@shared/totp-capture';
import type { CapturedTotp, TotpWriteTarget, Protocol2CredentialWriter } from '../vault/protocol2/credential-writer';
import type { SecretCaptureSource } from './secret-coordinator';

interface Session { profileId: string; generation: number; unlocked: boolean }
interface Deps {
  session(): Promise<Session | null>;
  current(source: SecretCaptureSource): Promise<boolean>;
  sourceMatches(source: SecretCaptureSource, expected: CapturedTotp): Promise<boolean>;
  activeTabId(): Promise<number | null>;
  choices(url: string, entry?: TotpEntryRef): Promise<TotpWriteTarget[]>;
  resolveIcon?(url:string): Promise<string | undefined>;
  save(totp: CapturedTotp, url: string, target: TotpWriteTarget, authorized: () => Promise<boolean>, create?: { label: string; username: string }, confirmDomainMismatch?: boolean): ReturnType<Protocol2CredentialWriter['saveTotp']>;
  invalidated?(): void;
  now?: () => number;
  createId?: () => string;
}
interface Pending {
  entryScope: TotpEntryRef | null; icon?: string; iconResolved?: boolean;
  id: string; source: SecretCaptureSource; session: Session; totp: CapturedTotp; expires: number;
  targets: Map<string, TotpWriteTarget>; loaded: boolean; loading: Promise<boolean> | null; saving: boolean; dismissed: boolean;
}
export class TotpCaptureCoordinator {
  private readonly pending = new Map<number, Pending>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly createId: () => string;
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now; this.createId = deps.createId ?? (() => crypto.randomUUID()); }
  clear(): void { for (const tabId of this.pending.keys()) this.clearTab(tabId); }
  clearDocument(tabId: number, browserDocumentId: string): boolean {
    return !!this.pending.get(tabId) && captureDocumentKey(this.pending.get(tabId)!.source) === browserDocumentId && this.clearTab(tabId);
  }
  invalidateDocument(tabId: number, browserDocumentId: string): boolean {
    const pending = this.pending.get(tabId);
    return !!pending && !pending.dismissed && this.clearDocument(tabId, browserDocumentId);
  }
  clearTab(tabId: number): boolean { const removed = this.pending.delete(tabId); const timer = this.timers.get(tabId); if (timer) clearTimeout(timer); this.timers.delete(tabId); return removed; }
  async observe(uri: string, source: SecretCaptureSource, initiatingSessionCurrent: () => boolean = () => true, manual = false): Promise<{ status: 'accepted'; id: string; notice: CaptureNoticeIdentity } | { status: 'invalid' | 'stale' | 'dismissed' }> {
    if (source.frameId !== 0 || captureDocumentKey(source) !== captureTopDocumentKey(source) || !source.url.startsWith('https://')) return { status: 'stale' };
    const parsed = parseCapturedTotp(uri);
    if (!parsed || (parsed.digits !== 6 && parsed.digits !== 8)) return { status: 'invalid' };
    const session = await this.deps.session();
    if (!initiatingSessionCurrent() || !session?.unlocked || !(await this.deps.current(source))) return { status: 'stale' };
    const current = await this.deps.session();
    if (!initiatingSessionCurrent() || !current?.unlocked || current.generation !== session.generation || current.profileId !== session.profileId) return { status: 'stale' };
    const totp: CapturedTotp = { ...parsed, digits: parsed.digits as 6 | 8, issuer: parsed.issuer ?? null, account: parsed.account ?? null };
    const notice = {kind:'totp' as const,site:new URL(source.url).hostname,name:new URL(source.url).hostname,detail:safeHint(totp.account,totp.secret) ?? ''};
    const existing = this.pending.get(source.tabId);
    if (existing && existing.expires > this.now() && captureDocumentKey(existing.source) === captureDocumentKey(source)
      && existing.source.documentId === source.documentId && existing.source.url === source.url
      && existing.session.profileId === session.profileId && existing.session.generation === session.generation
      && capturedTotpIdentity(existing.totp) === capturedTotpIdentity(totp)) {
      if (existing.dismissed) { if (!manual) return { status: 'dismissed' }; }
      else return { status: 'accepted', id: existing.id, notice };
    }
    if (this.pending.size >= 8 && !existing) this.clearTab(this.pending.keys().next().value!);
    this.clearTab(source.tabId);
    const pending: Pending = { entryScope: null, id: this.createId(), source, session, totp, expires: this.now() + 180_000, targets: new Map(), loaded: false, loading: null, saving: false, dismissed: false };
    this.pending.set(source.tabId, pending);
    const tabId = source.tabId, id = pending.id;
    this.timers.set(tabId, setTimeout(() => { if (this.pending.get(tabId)?.id === id) { this.clearTab(tabId); this.deps.invalidated?.(); } }, 180_000));
    return { status: 'accepted', id: pending.id, notice };
  }
  private async valid(p: Pending): Promise<boolean> {
    const session = await this.deps.session();
    return this.pending.get(p.source.tabId) === p && !p.dismissed && p.expires > this.now() && !!session?.unlocked
      && session.profileId === p.session.profileId && session.generation === p.session.generation
      && await this.deps.current(p.source) && this.pending.get(p.source.tabId) === p && !p.dismissed;
  }
  async matchesSource(id: string, source: SecretCaptureSource): Promise<boolean> {
    const item = this.pending.get(source.tabId);
    return !!item && item.id === id && item.source.frameId === source.frameId
      && captureDocumentKey(item.source) === captureDocumentKey(source) && captureTopDocumentKey(item.source) === captureTopDocumentKey(source)
      && item.source.documentId === source.documentId && item.source.url === source.url && !item.entryScope
      && await this.deps.activeTabId() === source.tabId && await this.valid(item);
  }
  async review(entryScope?: TotpEntryRef, expectedTabId?: number) {
    const tab = await this.deps.activeTabId(); const p = tab === null ? undefined : this.pending.get(tab);
    if (!p || expectedTabId !== undefined && tab !== expectedTabId || !(await this.valid(p))) return { status: 'empty' as const };
    if (entryScope) {
      if (p.saving) return { status: 'empty' as const };
      if (p.entryScope?.id !== entryScope.id || p.entryScope.vaultId !== entryScope.vaultId) {
        p.entryScope = { ...entryScope };
        p.loaded = false; p.targets.clear(); p.loading = null;
      }
    }
    if (!p.loaded) {
      if (!p.loading) p.loading = (async () => {
        const entryScope = p.entryScope;
        const targets = await this.deps.choices(p.source.url, entryScope ?? undefined);
        if (!(await this.valid(p)) || p.entryScope !== entryScope) return false;
        p.targets = new Map(targets.map(target => [this.createId(), target])); p.loaded = true;
        return true;
      })();
      const loading = p.loading;
      try { if (!(await loading)) return { status: 'empty' as const }; }
      finally { if (p.loading === loading) p.loading = null; }
    }
    if (!entryScope && !p.iconResolved) {
      const icon = await this.deps.resolveIcon?.(p.source.url).catch(() => undefined);
      if (!await this.valid(p)) return {status:'empty' as const};
      if (icon) p.icon=icon;
      p.iconResolved=true;
    }
    const targets = [...p.targets].filter(([, target]) => this.matchesEntry(p, target)).map(([id, target]) => ({ id, action: target.action, label: target.label,
      ...(target.action === 'create' && target.isDefault ? {isDefault:true} : {}),
      ...(target.action === 'update' && target.name ? {name:target.name} : {}),
      ...(target.action === 'update' && target.username ? {username:target.username} : {}),
      ...(target.action === 'update' && target.icon ? {icon:target.icon} : {}),
      vaultLabel: target.vaultLabel, vaultId: target.vaultId, entryId: target.action === 'update' ? target.entryId : null, domainMismatch: target.action === 'update' && target.domainMismatch === true, hasTotp: target.action === 'update' && target.hasTotp }));
    const updates = targets.filter(target => target.action === 'update');
    return { status: 'ready' as const, ...(p.icon ? {icon:p.icon} : {}), entryScope: p.entryScope, id: p.id, origin: new URL(p.source.url).origin,
      issuer: safeHint(p.totp.issuer, p.totp.secret), account: safeHint(p.totp.account, p.totp.secret), targets, defaultTargetId: updates.length === 1 ? updates[0]!.id : null };
  }
  private matchesEntry(p: Pending, target: TotpWriteTarget): boolean {
    return !p.entryScope || target.action === 'update' && target.vaultId === p.entryScope.vaultId && target.entryId === p.entryScope.id;
  }
  async save(id: string, targetId: string, replace: boolean, create?: { label: string; username: string }, confirmDomainMismatch = false, operationAuthorized: () => Promise<boolean> = async () => true) {
    const tab = await this.deps.activeTabId(); const p = tab === null ? undefined : this.pending.get(tab);
    if (!p || p.id !== id || !(await this.valid(p))) return { status: 'stale' as const };
    const target = p.targets.get(targetId);
    if (!target || !this.matchesEntry(p, target) || !p.loaded || p.saving) return { status: 'stale' as const };
    if (target.action === 'update' && target.domainMismatch && (!p.entryScope || !confirmDomainMismatch)) return { status: 'confirmation-required' as const };
    if (target.action === 'update' && target.hasTotp && !replace) return { status: 'confirmation-required' as const };
    if (target.action === 'create' && (!create || !create.label.trim() || create.label.length > 512 || create.username.length > 512)) return { status: 'invalid' as const };
    p.saving = true;
    const authorized = async () => {
      if (!await operationAuthorized() || !(await this.valid(p))) return false;
      if (!(await this.deps.sourceMatches(p.source, p.totp))) {
        if (this.pending.get(p.source.tabId) === p && !p.dismissed) { this.clearTab(p.source.tabId); this.deps.invalidated?.(); }
        return false;
      }
      return await operationAuthorized() && await this.valid(p);
    };
    try {
      if (!(await authorized())) return { status: 'stale' as const };
      const result = await this.deps.save(p.totp, p.source.url, target, authorized, create, target.action === 'update' && target.domainMismatch === true && confirmDomainMismatch);
      if (this.pending.get(p.source.tabId) === p) this.clearTab(p.source.tabId);
      return { status: 'saved' as const, ...(result.entryId && result.vaultId ? { entryId: result.entryId, vaultId: result.vaultId } : {}) };
    } catch { return await this.valid(p) ? { status: 'error' as const } : { status: 'stale' as const }; }
    finally { p.saving = false; }
  }
  async dismiss(id: string): Promise<void> {
    const tab = await this.deps.activeTabId(); const pending = tab === null ? undefined : this.pending.get(tab);
    if (pending?.id === id) { pending.dismissed = true; pending.targets.clear(); pending.loaded = false; }
  }
}

function safeHint(value: string | null, secret: string): string | null {
  if (!value || value.toUpperCase().replace(/[^A-Z2-7]/g, '').includes(secret.replace(/=+$/, ''))) return null;
  return value.slice(0, 256);
}
