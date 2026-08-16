export interface ContentWorkerPort {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface ReconnectingWorkerPort {
  postMessage(message: unknown): void;
  reconnect(): void;
}

/**
 * Keeps the isolated-world Port valid across service-worker restarts and BFCache
 * restores. Chrome reports BFCache eviction through runtime.lastError during
 * onDisconnect; reading it there marks the expected disconnect as handled.
 */
export function createReconnectingWorkerPort(
  connect: () => ContentWorkerPort,
  onMessage: (message: unknown) => void,
  consumeLastError: () => void,
): ReconnectingWorkerPort {
  let current: ContentWorkerPort | null = null;

  function open(): ContentWorkerPort {
    const next = connect();
    current = next;
    next.onMessage.addListener(onMessage);
    next.onDisconnect.addListener(() => {
      consumeLastError();
      if (current === next) current = null;
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
