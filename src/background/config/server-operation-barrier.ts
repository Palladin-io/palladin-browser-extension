export interface ServerOperationLease {
  readonly generation: number;
  release(): void;
}

/**
 * Linearizes every API-backed operation against a server change.
 *
 * A mutation closes admission synchronously, advances the generation, drains
 * operations that already captured the old server, and keeps admission closed
 * through logout, cache removal, and the durable URL commit.
 */
export class ServerOperationBarrier {
  private generation = 0;
  private activeOperations = 0;
  private mutationActive = false;
  private drain: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;

  tryAcquire(): ServerOperationLease | null {
    if (this.mutationActive) return null;
    this.activeOperations += 1;
    const generation = this.generation;
    let released = false;
    return {
      generation,
      release: () => {
        if (released) return;
        released = true;
        this.activeOperations -= 1;
        if (this.activeOperations === 0) {
          this.resolveDrain?.();
          this.drain = null;
          this.resolveDrain = null;
        }
      },
    };
  }

  async mutate<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    if (this.mutationActive) throw new Error("Server change already in progress");
    this.mutationActive = true;
    this.generation += 1;
    const generation = this.generation;
    try {
      if (this.activeOperations > 0) {
        this.drain ??= new Promise<void>((resolve) => { this.resolveDrain = resolve; });
        await this.drain;
      }
      return await operation(generation);
    } finally {
      this.mutationActive = false;
    }
  }
}
