import type { BridgeMessage, SessionLivenessPing } from "@shared/messaging";

export interface ContentWorkerPort {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  postMessage(message: BridgeMessage | SessionLivenessPing): void;
  disconnect(): void;
}

export interface ReconnectingWorkerPort {
  postMessage(message: BridgeMessage | SessionLivenessPing): void;
  reconnect(): void;
}

export type ContentPortDisconnectReason = "bfcache" | "worker" | "context-invalidated";

export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "";
  return /extension context invalidated/i.test(message);
}

/**
 * Keeps the isolated-world Port valid across service-worker restarts and BFCache
 * restores. Chrome reports BFCache eviction through runtime.lastError during
 * onDisconnect; reading it there marks the expected disconnect as handled.
 */
export function createReconnectingWorkerPort(
  connect: () => ContentWorkerPort,
  onMessage: (message: unknown) => void,
  consumeDisconnectReason: () => ContentPortDisconnectReason,
): ReconnectingWorkerPort {
  let current: ContentWorkerPort | null = null;
  let immediateWorkerReconnectUsed = false;
  let contextInvalidated = false;

  function invalidateContext(): void {
    contextInvalidated = true;
    current = null;
  }

  function open(): ContentWorkerPort {
    if (contextInvalidated) throw new Error("Extension context invalidated");
    const next = connect();
    current = next;
    next.onMessage.addListener((message) => {
      immediateWorkerReconnectUsed = false;
      onMessage(message);
    });
    next.onDisconnect.addListener(() => {
      const reason = consumeDisconnectReason();
      if (current !== next) return;
      current = null;
      if (reason === "context-invalidated") {
        invalidateContext();
        return;
      }
      // A worker restart erases its live document registry, so reconnect now
      // and wake the new worker. A BFCache document cannot keep a Port alive;
      // pageshow restores it explicitly instead.
      if (reason === "worker" && !immediateWorkerReconnectUsed) {
        immediateWorkerReconnectUsed = true;
        try {
          open();
        } catch (error) {
          if (isExtensionContextInvalidated(error)) invalidateContext();
        }
      }
    });
    return next;
  }

  function active(): ContentWorkerPort {
    return current ?? open();
  }

  // Register this document with the worker immediately. Agent Inject and
  // user-triggered fills bind delivery to that live document registration.
  open();

  return {
    postMessage(message) {
      if (contextInvalidated) return;
      let target: ContentWorkerPort;
      try {
        target = active();
      } catch (error) {
        if (isExtensionContextInvalidated(error)) invalidateContext();
        return;
      }
      try {
        target.postMessage(message);
        immediateWorkerReconnectUsed = false;
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          invalidateContext();
          return;
        }
        if (current === target) current = null;
        // The Port can close between active() and postMessage(). Re-register
        // and retry this one typed message once; never recurse indefinitely.
        try {
          active().postMessage(message);
        } catch (retryError) {
          if (isExtensionContextInvalidated(retryError)) invalidateContext();
          current = null;
        }
      }
    },
    reconnect() {
      if (contextInvalidated) return;
      immediateWorkerReconnectUsed = false;
      const previous = current;
      current = null;
      try {
        previous?.disconnect();
      } catch {
        // Already disconnected by BFCache or a worker restart.
      }
      try {
        open();
      } catch (error) {
        if (isExtensionContextInvalidated(error)) invalidateContext();
      }
    },
  };
}
