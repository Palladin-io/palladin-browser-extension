import type { SecretCaptureSource } from './secret-coordinator';
interface Frame { browserDocumentId: string; topDocumentId: string; origin: string }
export class SecretCaptureFrames {
  private readonly frames = new Map<string, Frame>();
  constructor(private readonly topDocument: (tabId: number) => string | null) {}
  register(sender: chrome.runtime.MessageSender | undefined, extensionId: string): (() => void) | null {
    if (!sender || !this.valid(sender, extensionId)) return null;
    const topDocumentId = this.topDocument(sender.tab!.id!);
    if (!topDocumentId) return null;
    const key = `${sender.tab!.id}:${sender.frameId}`;
    const frame = { browserDocumentId: sender.documentId!, topDocumentId, origin: new URL(sender.url!).origin };
    this.frames.set(key, frame);
    return () => { if (this.frames.get(key) === frame) this.frames.delete(key); };
  }
  clearTab(tabId: number): void { for (const key of this.frames.keys()) if (key.startsWith(`${tabId}:`)) this.frames.delete(key); }
  source(sender: chrome.runtime.MessageSender, extensionId: string, documentId: string): SecretCaptureSource | null {
    if (!this.valid(sender, extensionId)) return null;
    const frame = this.frames.get(`${sender.tab!.id}:${sender.frameId}`);
    if (!frame || frame.browserDocumentId !== sender.documentId || frame.topDocumentId !== this.topDocument(sender.tab!.id!) || frame.origin !== new URL(sender.url!).origin) return null;
    return { tabId: sender.tab!.id!, frameId: sender.frameId!, browserDocumentId: sender.documentId!, topDocumentId: frame.topDocumentId, documentId, url: sender.url! };
  }
  private valid(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
    try { return sender.id === extensionId && Number.isInteger(sender.frameId) && sender.frameId! >= 0
      && typeof sender.tab?.id === 'number' && typeof sender.documentId === 'string' && sender.documentId.length > 0
      && (sender.documentLifecycle === undefined || sender.documentLifecycle === 'active')
      && typeof sender.url === 'string' && new URL(sender.url).protocol === 'https:'
      && (sender.origin === undefined || sender.origin === new URL(sender.url).origin); }
    catch { return false; }
  }
}
