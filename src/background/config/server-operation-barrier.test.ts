import { describe, expect, it, vi } from "vitest";

import { ServerOperationBarrier } from "./server-operation-barrier";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ServerOperationBarrier", () => {
  it("drains the old generation and rejects late admission until mutation completes", async () => {
    const barrier = new ServerOperationBarrier();
    const lease = barrier.tryAcquire();
    expect(lease?.generation).toBe(0);
    const mutationEntered = vi.fn();
    const releaseMutation = deferred();
    const mutation = barrier.mutate(async (generation) => {
      mutationEntered(generation);
      await releaseMutation.promise;
      return "changed";
    });

    expect(barrier.tryAcquire()).toBeNull();
    expect(mutationEntered).not.toHaveBeenCalled();
    lease?.release();
    await vi.waitFor(() => expect(mutationEntered).toHaveBeenCalledWith(1));
    expect(barrier.tryAcquire()).toBeNull();

    releaseMutation.resolve();
    await expect(mutation).resolves.toBe("changed");
    const next = barrier.tryAcquire();
    expect(next?.generation).toBe(1);
    next?.release();
  });

  it("allows only one server mutation at a time", async () => {
    const barrier = new ServerOperationBarrier();
    const releaseMutation = deferred();
    const first = barrier.mutate(async () => releaseMutation.promise);

    await expect(barrier.mutate(async () => undefined)).rejects.toThrow(
      "Server change already in progress",
    );
    releaseMutation.resolve();
    await first;
  });
});
