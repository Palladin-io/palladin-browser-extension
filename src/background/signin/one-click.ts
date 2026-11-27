import type { OneClickCommand, OneClickResult, OneClickStage } from '@shared/messaging/one-click';
import { isSecurePage, matchesTab, registrableDomain } from '@shared/security/domain';
import type { SessionStatus } from '../session/types';
import type { ActiveTab } from '../vault/commands';
import { ENTRY_TYPE_CREDENTIAL, type EntryMetadata } from '../vault/entry-metadata';

const LIFETIME_MS = 60_000;
const MAX_STEPS = 8;

interface Run {
  readonly id: string;
  readonly vaultId: string;
  readonly entryId: string;
  readonly expiresAt: number;
  readonly session: number;
  host: string;
  moved: boolean;
  valueReleased: boolean;
  steps: number;
  readonly used: Set<OneClickStage>;
}

export interface OneClickDeps {
  now(): number;
  newId(): string;
  getStatus(): Promise<SessionStatus>;
  getMetadata(): Promise<EntryMetadata[]>;
  reportMissingPrompt(url: string): void;
}

/**
 * Memory-only authority for one explicit "Sign in" click. It permits stages; it
 * never releases a value. Every value still passes the normal fill gates.
 */
export class OneClickRuns {
  private readonly byTab = new Map<number, Run>();
  private readonly hiddenHosts = new Map<number, string>();
  private session = 0;
  constructor(private readonly deps: OneClickDeps) {}

  clearTab(tabId: number): void { this.byTab.delete(tabId); this.hiddenHosts.delete(tabId); }
  clear(): void { this.session++; this.byTab.clear(); }

  async dispatch(command: OneClickCommand, source: ActiveTab): Promise<OneClickResult> {
    if (command.type === 'stop') {
      if (this.byTab.get(source.id)?.id === command.runId) this.byTab.delete(source.id);
      return { status: 'stopped' };
    }
    const host = httpsHost(source.url);
    if (command.type === 'dismiss') {
      this.byTab.delete(source.id);
      if (host !== null) this.hiddenHosts.set(source.id, host);
      return { status: 'hidden' };
    }
    if (command.type === 'prompt-missing') {
      if (await this.missingPromptHasEntry(source)) this.deps.reportMissingPrompt(source.url);
      return { status: 'idle' };
    }
    const session = this.session;
    const unlocked = await this.deps.getStatus() === 'unlocked';
    const metadata = unlocked ? await this.deps.getMetadata() : [];
    if (!unlocked || session !== this.session) { this.byTab.delete(source.id); return { status: command.type === 'step' ? 'stopped' : 'idle' }; }
    if (command.type === 'start') {
      this.byTab.delete(source.id);
      const entry = this.entry(metadata, command.vaultId, command.entryId, source.url);
      if (host === null || entry === null) return { status: 'idle' };
      const run: Run = { id: this.deps.newId(), vaultId: command.vaultId, entryId: command.entryId, session,
        expiresAt: this.deps.now() + LIFETIME_MS, host, moved: false, valueReleased: false, steps: 0, used: new Set() };
      this.byTab.set(source.id, run);
      return this.view(run, entry, source.url);
    }

    if (command.type === 'resume') {
      if (this.hiddenHosts.get(source.id) !== host) this.hiddenHosts.delete(source.id);
      else if (!this.byTab.has(source.id)) return { status: 'hidden' };
    }
    const run = this.byTab.get(source.id);
    const entry = run ? this.entry(metadata, run.vaultId, run.entryId, source.url) : null;
    if (!run || host === null || entry === null || run.session !== this.session
      || this.deps.now() >= run.expiresAt || !this.sameHost(run, host)) {
      this.byTab.delete(source.id);
      return { status: command.type === 'step' ? 'stopped' : 'idle' };
    }
    if (command.type !== 'step') return this.view(run, entry, source.url);

    // A combined form after a rejected password must not submit that password again.
    if (command.runId !== run.id || run.steps >= MAX_STEPS || run.used.has(command.stage)
      || (command.stage === 'login' && run.used.has('password'))) {
      this.byTab.delete(source.id);
      return { status: 'stopped' };
    }
    run.steps++;
    run.used.add(command.stage);
    if (command.stage === 'login') { run.used.add('identifier'); run.used.add('password'); }
    if (command.stage !== 'entry') { run.valueReleased = true; run.used.add('entry'); }
    return { status: 'granted' };
  }

  /** The worker, not the page, decides that a saved entry exists for this host. */
  private async missingPromptHasEntry(source: ActiveTab): Promise<boolean> {
    const host = httpsHost(source.url);
    if (host === null || this.hiddenHosts.get(source.id) === host || await this.deps.getStatus() !== 'unlocked') return false;
    return (await this.deps.getMetadata()).some(entry => this.entry([entry], entry.vaultId, entry.id, source.url) !== null);
  }

  /** One move within the registrable domain, only while nothing has been released. */
  private sameHost(run: Run, host: string): boolean {
    if (run.host === host) return true;
    const site = registrableDomain(host);
    if (run.moved || run.valueReleased || site === null || site !== registrableDomain(run.host)) return false;
    run.host = host;
    run.moved = true;
    return true;
  }

  private entry(metadata: readonly EntryMetadata[], vaultId: string, entryId: string, url: string): EntryMetadata | null {
    const entry = metadata.find(item => item.vaultId === vaultId && item.id === entryId);
    return entry && entry.type === ENTRY_TYPE_CREDENTIAL && entry.urlDomain && entry.username !== undefined
      && isSecurePage(url) && matchesTab(url, entry.urlDomain, { exactSubdomain: false }) ? entry : null;
  }

  private view(run: Run, entry: EntryMetadata, url: string): OneClickResult {
    return { status: 'run', run: { runId: run.id, vaultId: run.vaultId, entryId: run.entryId, name: entry.name,
      username: entry.username!, match: matchesTab(url, entry.urlDomain!) ? 'exact' : 'related' } };
  }
}

function httpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch { return null; }
}
