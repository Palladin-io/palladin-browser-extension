import type { CaptureDraft } from '../../shared/messaging/capture-draft';
import { captureDocumentKey, captureTopDocumentKey } from './document-identity';
import { isInlineCaptureReviewCommand, type InlineCaptureKind, type InlineCaptureReviewCommand, type InlineCaptureReviewResult } from '../../shared/messaging/inline-capture-review';
import { isManualEntrySaveInput } from '../vault/commands';
import type { SecretCaptureSource } from './secret-coordinator';
export function inlineDocumentLifecycle(frameUrl: string, lifecycle: string | undefined): boolean {
  if (frameUrl.startsWith('chrome-extension://')) return lifecycle === 'active';
  return (frameUrl.startsWith('moz-extension://') || frameUrl.startsWith('safari-web-extension://')) && (lifecycle === undefined || lifecycle === 'active');
}
interface Request { kind: InlineCaptureKind; captureId: string; documentId: string }
export interface InlineCaptureReviewDependencies {
  runtimeId: string; frameUrl: string; now?(): number;
  sessionGeneration(): number;
  resolveSource?(sender: chrome.runtime.MessageSender, documentId: string): Promise<SecretCaptureSource | null>;
  current(source: SecretCaptureSource): Promise<boolean>;
  attest(source: SecretCaptureSource, frame: chrome.runtime.MessageSender | null, phase: 'mint' | 'connect' | 'operation'): Promise<boolean>;
  verifyFrameParent(frame: chrome.runtime.MessageSender, source: SecretCaptureSource): Promise<boolean>;
  navigateDraft?(kind: InlineCaptureKind, captureId: string, source: SecretCaptureSource): Promise<boolean>;
  navigateSaved?(receipt: {vaultId:string;entryId:string}, source: SecretCaptureSource): Promise<boolean>;
  candidate(kind: InlineCaptureKind, id: string, source: SecretCaptureSource): Promise<boolean>;
  dispatch(command: InlineCaptureReviewCommand, source: SecretCaptureSource, captureId: string, authorized: () => Promise<boolean>): Promise<InlineCaptureReviewResult>;
}
interface Session extends Request {
  source: SecretCaptureSource; owner: object; generation: number; expires: number;
  receipt?: {vaultId:string;entryId:string}; terminal?: boolean; frame?: chrome.runtime.MessageSender; port?: object; busy: boolean;
}
export class InlineCaptureReviewSessions {
  private readonly drafts=new Map<string,{session:Session;draft:CaptureDraft;timer:ReturnType<typeof setTimeout>}>();
  private dropDraft(key:string):void { const value=this.drafts.get(key); if(value)clearTimeout(value.timer);this.drafts.delete(key); }
  async takeDraft(kind:InlineCaptureKind,id:string):Promise<CaptureDraft|null>{
    const key=`${kind}:${id}`,value=this.drafts.get(key);if(!value)return null;
    this.dropDraft(key);
    const {session}=value;
    const epoch=this.epoch;
    if(session.expires<=this.now()||session.generation!==this.deps.sessionGeneration()||!await this.deps.current(session.source)||!await this.deps.candidate(kind,id,session.source)||!await this.deps.current(session.source)||epoch!==this.epoch||session.expires<=this.now()||session.generation!==this.deps.sessionGeneration())return null;
    return value.draft;
  }
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private epoch = 0;
  private readonly ownerEpochs = new WeakMap<object, number>();
  constructor(private readonly deps: InlineCaptureReviewDependencies) { this.now = deps.now ?? Date.now; }
  clear(): void { this.epoch++; this.sessions.clear(); for(const key of this.drafts.keys())this.dropDraft(key); }
  revokeOwner(owner: object): void { this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1); for (const [key, session] of this.sessions) if (session.owner === owner || session.port === owner) this.sessions.delete(key); }
  revokeTab(tabId: number): void { this.epoch++; for(const [key,value] of this.drafts)if(value.session.source.tabId===tabId)this.dropDraft(key); for (const [key, session] of this.sessions) if (session.source.tabId === tabId) this.sessions.delete(key); }
  private live(key: string, session: Session): boolean {
    return this.sessions.get(key) === session && session.generation === this.deps.sessionGeneration() && session.expires > this.now();
  }
  async mint(sender: chrome.runtime.MessageSender, request: Request, owner: object): Promise<string | null> {
    try {
      if (sender.id !== this.deps.runtimeId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)
        || sender.tab?.incognito || !inlineDocumentLifecycle(this.deps.frameUrl, sender.documentLifecycle) || !sender.url || new URL(sender.url).protocol !== 'https:'
        || !['login','secret','totp'].includes(request.kind) || !request.captureId || request.captureId.length > 256 || !request.documentId || request.documentId.length > 128) return null;
      const resolvingEpoch=this.epoch, resolvingOwnerEpoch=this.ownerEpochs.get(owner);
      const source = this.deps.resolveSource ? await this.deps.resolveSource(sender, request.documentId)
        : sender.documentId ? { tabId: sender.tab!.id!, frameId: 0, browserDocumentId: sender.documentId, topDocumentId: sender.documentId, documentId: request.documentId, url: sender.url } : null;
      if (resolvingEpoch !== this.epoch || resolvingOwnerEpoch !== this.ownerEpochs.get(owner)) return null;
      if (!source || !captureDocumentKey(source) || captureDocumentKey(source) !== captureTopDocumentKey(source) || source.tabId !== sender.tab!.id || source.frameId !== 0 || source.documentId !== request.documentId || source.url !== sender.url) return null;
      this.revokeOwner(owner);
      const ownerEpoch = this.ownerEpochs.get(owner);
      const epoch = this.epoch;
      const generation = this.deps.sessionGeneration();
      if (!await this.deps.current(source) || !await this.deps.candidate(request.kind, request.captureId, source)
        || !await this.deps.attest(source, null, 'mint') || generation !== this.deps.sessionGeneration() || !await this.deps.current(source)) return null;
      if (this.ownerEpochs.get(owner) !== ownerEpoch || this.epoch !== epoch) return null;
      const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      this.sessions.set(key, { ...request, source, owner, generation, expires: this.now() + 180_000, busy: false });
      return key;
    } catch { return null; }
  }
  private frameValid(sender: chrome.runtime.MessageSender, session: Session): boolean {
    return sender.id === this.deps.runtimeId && sender.url === this.deps.frameUrl && sender.tab?.id === session.source.tabId
      && Number.isInteger(sender.frameId) && sender.frameId! > 0 && (typeof sender.documentId === 'string' && sender.documentId.length > 0 || !!session.source.legacyRouteId && this.deps.frameUrl.startsWith('moz-extension://') && sender.documentId === undefined)
      && inlineDocumentLifecycle(this.deps.frameUrl, sender.documentLifecycle) && !sender.tab?.incognito;
  }
  async connect(key: string, sender: chrome.runtime.MessageSender, port: object): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session || session.port || !this.live(key, session) || !this.frameValid(sender, session)) return false;
    // Reserve synchronously: two frame connections cannot race to claim one capability.
    session.port = port; session.frame = { ...sender, tab: sender.tab ? { ...sender.tab } : undefined };
    try {
      if (!await this.deps.verifyFrameParent(sender, session.source) || !await this.deps.current(session.source)
        || !await this.deps.attest(session.source, sender, 'connect') || !this.live(key, session)) { this.sessions.delete(key); return false; }
      return true;
    } catch { this.sessions.delete(key); return false; }
  }
  async dispatch(raw: unknown, sender: chrome.runtime.MessageSender, port: object): Promise<InlineCaptureReviewResult> {
    if (!isInlineCaptureReviewCommand(raw, isManualEntrySaveInput)) return { status: 'stale' };
    const session = this.sessions.get(raw.capability);
    if (!session || session.busy || session.port !== port || !this.frameValid(sender, session)
      || sender.frameId !== session.frame?.frameId || sender.documentId !== session.frame?.documentId || raw.kind !== session.kind
      || ('promptId' in raw.command && raw.command.promptId !== session.captureId) || ('id' in raw.command && raw.command.id !== session.captureId)) return { status: 'stale' };
    const authorized = async () => this.live(raw.capability, session)
      && await this.deps.current(session.source) && await this.deps.verifyFrameParent(sender, session.source)
      && await this.deps.attest(session.source, sender, 'operation') && this.live(raw.capability, session);
    session.busy = true;
    try {
      if (raw.command.type === 'open-saved') {
        if (!session.receipt || !await authorized() || !await this.deps.navigateSaved?.(session.receipt, session.source)) return {status:'stale'};
        this.sessions.delete(raw.capability); return {status:'dismissed'};
      }
      if (session.terminal) return {status:'stale'};
      if (raw.command.type === 'open-draft') {
        if (!await authorized() || !await this.deps.candidate(session.kind,session.captureId,session.source) || !await authorized()) return {status:'stale'};
        const key=`${session.kind}:${session.captureId}`;
        this.dropDraft(key);
        if(this.drafts.size>=8)this.dropDraft(this.drafts.keys().next().value!);
        this.drafts.set(key,{session,draft:structuredClone(raw.command.draft),timer:setTimeout(()=>this.dropDraft(key),Math.max(0,session.expires-this.now()))});
        try {
          if(!await this.deps.navigateDraft?.(session.kind,session.captureId,session.source)){this.dropDraft(key);return {status:'stale'};}
        } catch {this.dropDraft(key);return {status:'stale'};}
        this.sessions.delete(raw.capability); return {status:'dismissed'};
      }
      if (!await authorized() || !await this.deps.candidate(session.kind, session.captureId, session.source) || !await authorized()) return { status: 'stale' };
      const result = await this.deps.dispatch(raw, session.source, session.captureId, authorized);
      if (!await authorized()) return { status: 'stale' };
      if (result.status === 'saved') {
        session.terminal=true;
        if ('entryId' in result && typeof result.entryId === 'string' && 'vaultId' in result && typeof result.vaultId === 'string') session.receipt={entryId:result.entryId,vaultId:result.vaultId};
      }
      if (result.status === 'dismissed') this.sessions.delete(raw.capability);
      return result;
    } catch { return { status: 'stale' }; }
    finally { session.busy = false; if (!this.live(raw.capability, session)) this.sessions.delete(raw.capability); }
  }
}
