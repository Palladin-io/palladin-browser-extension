import { describe, expect, it, vi } from "vitest";

import { handleServerConfigRuntimeMessage } from "./server-commands";
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

  it("serializes concurrent mutations and keeps admission closed across the queue", async () => {
    const barrier = new ServerOperationBarrier();
    const releaseMutation = deferred();
    const order: string[] = [];
    const first = barrier.mutate(async () => {
      order.push("first:start");
      await releaseMutation.promise;
      order.push("first:end");
    });
    const second = barrier.mutate(async () => { order.push("second"); });

    expect(barrier.tryAcquire()).toBeNull();
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseMutation.resolve();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
    const lease = barrier.tryAcquire();
    expect(lease?.generation).toBe(2);
    lease?.release();
  });

  it("keeps a permission needed by the host committed by an earlier queued change", async () => {
    const barrier = new ServerOperationBarrier();
    const releaseFirst = deferred();
    let current = "https://api.palladin.io";
    const save = vi.fn(async (apiUrl: string) => { current = apiUrl; return apiUrl; });
    const removeUnused = vi.fn(async () => undefined);
    const command = { type: "config/server/set", apiUrl: "https://vault.example.com" } as const;
    let beforeCalls = 0;
    const execute = () => handleServerConfigRuntimeMessage({
      getApiUrl: () => current,
      hasAccess: vi.fn(async () => true),
      beforeChange: async () => {
        beforeCalls += 1;
        if (beforeCalls === 1) await releaseFirst.promise;
      },
      save,
      afterChange: removeUnused,
      afterFailedChange: removeUnused,
    }, command);

    const first = barrier.mutate(execute);
    const second = barrier.mutate(execute);
    await vi.waitFor(() => expect(beforeCalls).toBe(1));
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ ok: true, changed: true });
    await expect(second).resolves.toMatchObject({ ok: true, changed: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(removeUnused).toHaveBeenCalledTimes(1);
    expect(removeUnused).toHaveBeenCalledWith(
      "https://api.palladin.io",
      "https://vault.example.com",
    );
  });
});
