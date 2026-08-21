import {
  sessionLivenessControl,
  type SessionLivenessControl,
} from "@shared/messaging";

export interface SessionLivenessPort {
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  postMessage(message: SessionLivenessControl): void;
}

/**
 * Publishes the worker-owned unlocked state to content scripts without keys,
 * tokens, user ids, timestamps, or page-visible traffic.
 */
export class SessionLivenessPublisher {
  private readonly ports = new Set<SessionLivenessPort>();
  private generation = 0;

  register(port: SessionLivenessPort, readUnlocked: () => Promise<boolean>): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    const generation = this.generation;
    void readUnlocked().then((enabled) => {
      if (generation !== this.generation || !this.ports.has(port)) return;
      this.post(port, enabled);
    }).catch(() => this.post(port, false));
  }

  setEnabled(enabled: boolean): void {
    this.generation += 1;
    for (const port of this.ports) this.post(port, enabled);
  }

  private post(port: SessionLivenessPort, enabled: boolean): void {
    try {
      port.postMessage(sessionLivenessControl(enabled));
    } catch {
      this.ports.delete(port);
    }
  }
}
