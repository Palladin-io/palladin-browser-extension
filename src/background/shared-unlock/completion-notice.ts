import { SHARED_UNLOCK_NOTICE_PORT, isSharedUnlockNoticeVisibility, type SharedUnlockNotice } from '../../shared/messaging/shared-unlock-notice';
import { isTrustedExtensionPage, type RuntimeSenderIdentity } from '../trusted-sender';

export interface CompletionNoticePort {
  readonly name: string;
  readonly sender?: RuntimeSenderIdentity | undefined;
  readonly onMessage: { addListener(listener: (raw: unknown) => void): void; removeListener(listener: (raw: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  postMessage(message: SharedUnlockNotice): void;
  disconnect(): void;
}

/** One immediate recipient, no queued result, identifiers, storage or retry. */
export class SharedUnlockCompletionNotice {
  private readonly surfaces = new Map<CompletionNoticePort, boolean>();

  register(port: CompletionNoticePort, runtimeId: string, origin: string): void {
    if (port.name !== SHARED_UNLOCK_NOTICE_PORT || !port.sender
      || !isTrustedExtensionPage(port.sender, runtimeId, origin)
      || !['src/popup/index.html', 'src/side-panel/index.html'].some(path => port.sender?.url === origin + path)
      || this.surfaces.size >= 32) { port.disconnect(); return; }
    this.surfaces.set(port, false);
    const remove = () => {
      this.surfaces.delete(port);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(remove);
    };
    const message = (raw: unknown) => {
      if (!isSharedUnlockNoticeVisibility(raw)) { remove(); port.disconnect(); return; }
      this.surfaces.set(port, raw.visible);
    };
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(remove);
  }

  completed(): void {
    for (const [port, visible] of this.surfaces) {
      if (!visible) continue;
      try { port.postMessage({ type: 'completed', occurredAt: Date.now() }); }
      catch { /* Delivery may be ambiguous: never reroute or replay a completion. */ }
      return;
    }
  }

  clear(): void {
    for (const port of this.surfaces.keys()) {
      try { port.postMessage({ type: 'clear' }); } catch { /* Closing surfaces need no retry. */ }
    }
  }
}

export const sharedUnlockCompletionNotice = new SharedUnlockCompletionNotice();
