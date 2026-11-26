/**
 * Toolbar attention for Inbox items that arrived while the user was not
 * looking at the Inbox. The count is value-free, lives only in worker memory
 * and is cleared on lock.
 */

export const INBOX_SEEN_MESSAGE = 'workspace/inbox-seen';
const BADGE_COLOR = '#EB4747';

export interface InboxAttentionDeps {
  action: {
    setBadgeText(details: { text: string }): unknown;
    setBadgeBackgroundColor(details: { color: string }): unknown;
  };
  pendingGrants(): Promise<number | null>;
}

export function isInboxSeenMessage(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Object.keys(raw).length === 1
    && (raw as { type?: unknown }).type === INBOX_SEEN_MESSAGE;
}

export function inboxBadgeText(count: number): string {
  return count > 99 ? '99+' : count > 0 ? String(count) : '';
}

export class InboxAttention {
  private unseen = 0;
  private active = false;
  private generation = 0;

  constructor(private readonly deps: InboxAttentionDeps) {}

  /** Seeds the count with requests that already wait for a decision. */
  async unlocked(): Promise<void> {
    const generation = ++this.generation;
    this.active = true;
    this.unseen = 0;
    this.render();
    const pending = await this.deps.pendingGrants().catch(() => null);
    if (generation !== this.generation || pending === null) return;
    this.unseen = Math.max(this.unseen, pending);
    this.render();
  }

  notified(): void {
    if (!this.active) return;
    this.unseen += 1;
    this.render();
  }

  seen(): void {
    if (!this.active) return;
    // A pending-count seed still in flight must not restore what the user has seen.
    ++this.generation;
    this.unseen = 0;
    this.render();
  }

  locked(): void {
    ++this.generation;
    this.active = false;
    this.unseen = 0;
    this.render();
  }

  private render(): void {
    void Promise.resolve(this.deps.action.setBadgeBackgroundColor({ color: BADGE_COLOR })).catch(() => undefined);
    void Promise.resolve(this.deps.action.setBadgeText({ text: inboxBadgeText(this.unseen) })).catch(() => undefined);
  }
}
