import {
  SESSION_LIVENESS_CHANNEL,
  SESSION_LIVENESS_PORT,
} from "@shared/messaging";

import { SESSION_KEEPALIVE_INTERVAL_MS } from "../../content/isolated/session-keepalive";

const INJECTED_STATE_KEY = "__palladinSessionLivenessV1";

interface InjectedLivenessState {
  alive: boolean;
  stop(): void;
}

/**
 * Install a value-free heartbeat in the active tab after an explicit popup
 * unlock. This covers tabs that were already open when an unpacked extension
 * was installed or reloaded, before declarative content scripts can run on the
 * next navigation. It has no DOM access and carries no key, token, user id, or
 * activity timestamp.
 */
export async function ensureActiveTabSessionLiveness(): Promise<void> {
  if (!chrome.scripting?.executeScript) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: installActiveTabSessionLiveness,
    args: [
      INJECTED_STATE_KEY,
      SESSION_LIVENESS_PORT,
      SESSION_LIVENESS_CHANNEL,
      SESSION_KEEPALIVE_INTERVAL_MS,
    ],
  }).catch(() => undefined);
}

/** Exported only so its lifecycle can be tested before Chrome serializes it. */
export function installActiveTabSessionLiveness(
  stateKey: string,
  portName: string,
  channel: string,
  intervalMs: number,
): void {
  const scope = globalThis as typeof globalThis & Record<string, InjectedLivenessState | undefined>;
  const previous = scope[stateKey];
  if (previous?.alive) return;
  previous?.stop();

  let alive = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let port: chrome.runtime.Port | null = null;

  function contextIsInvalidated(error?: unknown): boolean {
    const message = error instanceof Error
      ? error.message
      : typeof error === "string" ? error : "";
    if (/extension context invalidated/i.test(message)) return true;
    try {
      return !chrome.runtime.id;
    } catch {
      return true;
    }
  }

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function applyEnabled(next: boolean): void {
    stopTimer();
    if (!next || !alive) return;
    timer = setInterval(() => {
      try {
        port?.postMessage({ channel, type: "ping" });
      } catch (error) {
        if (contextIsInvalidated(error)) state.stop();
      }
    }, intervalMs);
  }

  function scheduleReconnect(error?: unknown): void {
    if (contextIsInvalidated(error)) {
      state.stop();
      return;
    }
    if (!alive || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function connect(): void {
    if (!alive) return;
    try {
      port = chrome.runtime.connect({ name: portName });
      port.onMessage.addListener((raw: unknown) => {
        if (typeof raw !== "object" || raw === null) return;
        const message = raw as Record<string, unknown>;
        if (message.channel === channel && message.type === "control" && typeof message.enabled === "boolean") {
          applyEnabled(message.enabled);
        }
      });
      port.onDisconnect.addListener(() => {
        let lastError = "";
        try {
          lastError = chrome.runtime.lastError?.message ?? "";
        } catch {
          lastError = "Extension context invalidated";
        }
        port = null;
        stopTimer();
        scheduleReconnect(lastError);
      });
    } catch (error) {
      scheduleReconnect(error);
    }
  }

  const state: InjectedLivenessState = {
    alive: true,
    stop() {
      alive = false;
      state.alive = false;
      stopTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        port?.disconnect();
      } catch {
        // A stale extension context may already have invalidated the port.
      }
      port = null;
    },
  };
  scope[stateKey] = state;
  addEventListener("pagehide", () => state.stop(), { once: true });
  connect();
}
