/** Linearization barrier between active Agent fills and pairing mutations. */

export interface AgentPairingMutationLease {
  /** Resolves only after every fill admitted before this mutation has finished. */
  readonly drain: Promise<void>;
  /** Re-open admission only when this lease still owns the newest generation. */
  release(): void;
}

/**
 * Synchronously closes fill admission and drains operations admitted beforehand.
 *
 * JavaScript cannot cancel a content-script message whose DOM work has already
 * started. Instead, pairing mutation success is linearized after that old work
 * finishes. No operation admitted after `beginMutation()` can cross the barrier.
 */
export class AgentFillMutationBarrier {
  private generation = 0;
  private blocked = false;
  private activeOperations = 0;
  private readonly drainWaiters = new Set<() => void>();

  get isBlocked(): boolean {
    return this.blocked;
  }

  admit<T>(operation: () => Promise<T>): Promise<T> | null {
    if (this.blocked) return null;
    this.activeOperations += 1;
    try {
      return operation().finally(() => this.completeOperation());
    } catch (error) {
      this.completeOperation();
      return Promise.reject(error);
    }
  }

  beginMutation(): AgentPairingMutationLease {
    const generation = ++this.generation;
    this.blocked = true;
    const drain = this.activeOperations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.drainWaiters.add(resolve));
    let released = false;
    return {
      drain,
      release: () => {
        if (released) return;
        released = true;
        if (generation === this.generation) this.blocked = false;
      },
    };
  }

  private completeOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
