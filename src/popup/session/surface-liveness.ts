import {
  SESSION_LIVENESS_CHANNEL,
  SESSION_LIVENESS_INTERVAL_MS,
  SESSION_LIVENESS_PORT,
  isSessionLivenessControl,
} from "@shared/messaging";

export interface SurfaceLivenessPort {
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: { readonly channel: typeof SESSION_LIVENESS_CHANNEL; readonly type: "ping" }): void;
  disconnect(): void;
}

export interface SurfaceLivenessRuntime {
  connect(options: { readonly name: typeof SESSION_LIVENESS_PORT }): SurfaceLivenessPort;
}

export interface SurfaceLivenessTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: SurfaceLivenessTimers = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keep the unlocked worker alive while the browser-owned side panel is open.
 * The channel is value-free and never counts as user activity, so it cannot
 * extend the configured idle deadline. It only prevents Chrome's
 * routine MV3 retirement from destroying memory-only keys mid-session.
 */
export function startSurfaceSessionLiveness(
  runtime: SurfaceLivenessRuntime,
  timers: SurfaceLivenessTimers = defaultTimers,
  contextIsValid: () => boolean = () => true,
): { stop(): void } {
  let alive = true;
  let port: SurfaceLivenessPort | null = null;
  let interval: unknown | null = null;
  let reconnect: unknown | null = null;

  function hasValidContext(error?: unknown): boolean {
    const message = error instanceof Error
      ? error.message
      : typeof error === "string" ? error : "";
    if (/extension context invalidated/i.test(message)) return false;
    try {
      return contextIsValid();
    } catch {
      return false;
    }
  }

  function stopInterval(): void {
    if (interval === null) return;
    timers.clearInterval(interval);
    interval = null;
  }

  function invalidate(): void {
    alive = false;
    stopInterval();
    if (reconnect !== null) timers.clearTimeout(reconnect);
    reconnect = null;
    port = null;
  }

  function setEnabled(enabled: boolean): void {
    stopInterval();
    if (!enabled || !alive) return;
    interval = timers.setInterval(() => {
      try {
        port?.postMessage({ channel: SESSION_LIVENESS_CHANNEL, type: "ping" });
      } catch (error) {
        if (!hasValidContext(error)) invalidate();
      }
    }, SESSION_LIVENESS_INTERVAL_MS);
  }

  function connect(): void {
    if (!alive) return;
    try {
      const next = runtime.connect({ name: SESSION_LIVENESS_PORT });
      port = next;
      next.onMessage.addListener((message) => {
        if (isSessionLivenessControl(message)) setEnabled(message.enabled);
      });
      next.onDisconnect.addListener(() => {
        if (port !== next) return;
        port = null;
        stopInterval();
        if (!hasValidContext()) {
          invalidate();
          return;
        }
        if (alive) reconnect = timers.setTimeout(connect, 1_000);
      });
    } catch (error) {
      if (!hasValidContext(error)) {
        invalidate();
        return;
      }
      reconnect = timers.setTimeout(connect, 1_000);
    }
  }

  connect();
  return {
    stop() {
      alive = false;
      stopInterval();
      if (reconnect !== null) timers.clearTimeout(reconnect);
      reconnect = null;
      try {
        port?.disconnect();
      } catch {
        // A stale worker may already have closed the port.
      }
      port = null;
    },
  };
}
