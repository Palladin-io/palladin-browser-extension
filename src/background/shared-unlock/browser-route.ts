import { SHARED_UNLOCK_BROWSER_PORT, isSharedUnlockBrowserMessage, type SharedUnlockBrowserMessage } from "../../shared/messaging/shared-unlock-browser";
import type { SharedUnlockOperationFrame, SharedUnlockOperationMessage } from "../../shared/messaging/shared-unlock-operation";
import type { SharedUnlockEnvironment } from "../../shared/config/shared-unlock-environments";

/** Shared framing only. Each browser adapter owns its independent authority checks. */
export abstract class SharedUnlockBrowserRoute {
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly extensionId: string;
  readonly channelId: string;
  readonly documentBinding: string;
  private closed = false;
  private readonly abort = new AbortController();
  private webNonce: string | null = null;
  private readonly operationListeners = new Set<(message: SharedUnlockOperationMessage) => void>();
  get signal(): AbortSignal { return this.abort.signal; }
  protected constructor(private readonly port: chrome.runtime.Port, environment: SharedUnlockEnvironment,
    extensionId: string, channelId: string, documentBinding: string, private readonly onClosed: () => void) {
    this.apiUrl = environment.apiUrl; this.webOrigin = environment.webOrigin;
    this.extensionId = extensionId; this.channelId = channelId; this.documentBinding = documentBinding;
  }
  protected abstract assertBrowserCurrent(): void;
  abstract verifyCurrent(): Promise<void>;
  assertCurrent(): void {
    try {
      if (this.closed) throw new Error("Shared unlock browser route closed");
      this.assertBrowserCurrent();
    } catch (error) { this.close(); throw error; }
  }
  openOperations(webNonce: string): void {
    this.assertCurrent();
    if (this.webNonce !== null) throw new Error("Shared unlock channel already ready");
    this.webNonce = webNonce;
  }
  onOperation(listener: (message: SharedUnlockOperationMessage) => void): () => void {
    this.assertCurrent();
    this.operationListeners.add(listener);
    return () => this.operationListeners.delete(listener);
  }
  sendOperation(payload: SharedUnlockOperationMessage): void {
    if (!this.webNonce) throw new Error("Shared unlock channel not ready");
    this.post({ type: "operation", protocol: SHARED_UNLOCK_BROWSER_PORT, apiUrl: this.apiUrl,
      webNonce: this.webNonce, channelId: this.channelId, documentBinding: this.documentBinding, ...payload });
  }
  receiveOperation(frame: SharedUnlockOperationFrame): void {
    this.assertCurrent();
    if (frame.apiUrl !== this.apiUrl || frame.webNonce !== this.webNonce || frame.channelId !== this.channelId
      || frame.documentBinding !== this.documentBinding || !this.operationListeners.size) {
      this.close(); throw new Error("Shared unlock operation route mismatch");
    }
    for (const listener of [...this.operationListeners]) { this.assertCurrent(); listener({ attemptId: frame.attemptId, payload: frame.payload }); }
  }

  /** Transport callers must finish verifyCurrent immediately before a sensitive send. */
  post(message: SharedUnlockBrowserMessage): void {
    this.assertCurrent();
    if (!isSharedUnlockBrowserMessage(message)) throw new Error("Invalid shared unlock browser message");
    this.port.postMessage(message);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.operationListeners.clear();
    try { this.port.disconnect(); } catch { /* already disconnected */ }
    this.onClosed();
  }
}
