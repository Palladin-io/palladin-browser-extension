import type { BridgeMessage } from "@shared/messaging";

export interface ContentWorkerPort {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  postMessage(message: BridgeMessage): void;
  disconnect(): void;
}

export interface ReconnectingWorkerPort {
  postMessage(message: BridgeMessage): void;
  reconnect(): void;
}

export type ContentPortDisconnectReason = "bfcache" | "worker";

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

  function open(): ContentWorkerPort {
    const next = connect();
    current = next;
    next.onMessage.addListener(onMessage);
    next.onDisconnect.addListener(() => {
      const reason = consumeDisconnectReason();
      if (current !== next) return;
      current = null;
      // A worker restart erases its live document registry, so reconnect now
      // and wake the new worker. A BFCache document cannot keep a Port alive;
      // pageshow restores it explicitly instead.
      if (reason === "worker") {
        try {
          open();
        } catch {
          // Extension reload/uninstall invalidates this content-script context.
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
      const target = active();
      try {
        target.postMessage(message);
      } catch {
        if (current === target) current = null;
        // The Port can close between active() and postMessage(). Re-register
        // and retry this one typed message once; never recurse indefinitely.
        try {
          active().postMessage(message);
        } catch {
          current = null;
        }
      }
    },
    reconnect() {
      const previous = current;
      current = null;
      try {
        previous?.disconnect();
      } catch {
        // Already disconnected by BFCache or a worker restart.
      }
      open();
    },
  };
}
