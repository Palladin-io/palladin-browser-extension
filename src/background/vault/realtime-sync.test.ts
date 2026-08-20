import { describe, expect, it, vi } from "vitest";

import {
  VaultInvalidationCoordinator,
  parseVaultSyncInvalidation,
} from "./realtime-sync";

const VAULT_ID = "22222222-2222-4222-8222-222222222222";

function invalidation(version: string, removed = false): unknown {
  return {
    protocolVersion: 1,
    vaultId: VAULT_ID,
    memberSequence: version,
    mutationVersion: version,
    removed,
  };
}

describe("Vault realtime invalidation", () => {
  it("accepts only the exact canonical value-free contract", () => {
    expect(parseVaultSyncInvalidation(invalidation("24"))).toEqual(invalidation("24"));
    expect(parseVaultSyncInvalidation({ ...(invalidation("24") as object), label: "secret" })).toBeNull();
    expect(parseVaultSyncInvalidation(invalidation("024"))).toBeNull();
    expect(parseVaultSyncInvalidation(invalidation("18446744073709551616"))).toBeNull();
  });

  it("coalesces duplicate and out-of-order invalidations per Vault", async () => {
    let finish!: () => void;
    const apply = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const changed = vi.fn();
    const coordinator = new VaultInvalidationCoordinator({ apply, changed });

    coordinator.accept(invalidation("10"));
    coordinator.accept(invalidation("10"));
    coordinator.accept(invalidation("9"));
    expect(apply).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    coordinator.accept(invalidation("10"));
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("runs one newer invalidation after an in-flight version", async () => {
    let finishFirst!: () => void;
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const changed = vi.fn();
    const coordinator = new VaultInvalidationCoordinator({ apply, changed });

    coordinator.accept(invalidation("10"));
    coordinator.accept(invalidation("12", true));
    finishFirst();

    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]).toEqual([VAULT_ID, true]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("lets an equal-version removal tombstone dominate an in-flight update", async () => {
    let finishFirst!: () => void;
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const coordinator = new VaultInvalidationCoordinator({ apply, changed: vi.fn() });

    coordinator.accept(invalidation("10"));
    coordinator.accept(invalidation("10", true));
    finishFirst();

    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]).toEqual([VAULT_ID, true]);
  });

  it("does not publish stale completion after lock", async () => {
    let finish!: () => void;
    const changed = vi.fn();
    const coordinator = new VaultInvalidationCoordinator({
      apply: () => new Promise<void>((resolve) => { finish = resolve; }),
      changed,
    });

    coordinator.accept(invalidation("10"));
    coordinator.clear();
    finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(changed).not.toHaveBeenCalled();
  });

  it("drains a new-session invalidation after stale same-Vault work finishes", async () => {
    let finishStale!: () => void;
    const apply = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishStale = resolve; }))
      .mockResolvedValue(undefined);
    const changed = vi.fn();
    const coordinator = new VaultInvalidationCoordinator({ apply, changed });

    coordinator.accept(invalidation("10"));
    coordinator.clear();
    coordinator.accept(invalidation("11"));
    expect(apply).toHaveBeenCalledTimes(1);

    finishStale();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[1]).toEqual([VAULT_ID, false]);
  });
});
