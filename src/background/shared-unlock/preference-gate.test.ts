import { describe, expect, it, vi } from "vitest";
import { SharedUnlockPreferenceGate } from "./preference-gate";

const scope = { apiUrl: "https://api.test", accountId: "11111111-1111-4111-8111-111111111111" };
const key = "palladin.shared-unlock.pause.v1:" + JSON.stringify([scope.apiUrl, scope.accountId]);
function setup() {
  const values: Record<string, unknown> = {};
  const storage = { get: vi.fn(async () => structuredClone(values)), set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, structuredClone(next)); }) };
  return { values, storage, gate: new SharedUnlockPreferenceGate(storage) };
}

describe("local shared-unlock preference pause", () => {
  it("cancels synchronously and stays denied while storage is stalled", async () => {
    const f = setup(); await f.gate.isAllowed(scope);
    let finish!: () => void;
    f.storage.set.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const cancelled = vi.fn(); f.gate.subscribe(cancelled);
    const pause = f.gate.pause(scope);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(scope);
    expect(() => f.gate.assertAllowed(scope)).toThrow();
    await vi.waitFor(() => expect(finish).toBeDefined()); finish(); await pause.persisted;
  });
  it("keeps a failed pause in RAM and a successful pause across restart without secrets", async () => {
    const f = setup(); f.storage.set.mockRejectedValueOnce(new Error("disk"));
    const failed = f.gate.pause(scope);
    await expect(failed.persisted).rejects.toThrow();
    expect(await f.gate.isAllowed(scope)).toBe(false);
    const pause = f.gate.pause(scope); await pause.persisted;
    expect(await new SharedUnlockPreferenceGate(f.storage).isAllowed(scope)).toBe(false);
    expect(f.values[key]).toEqual({ version: 1, ...scope, pauseId: pause.id });
  });
  it("permits only the exact successful own save to clear the pause", async () => {
    const f = setup(), pause = f.gate.pause(scope); await pause.persisted;
    await expect(f.gate.complete(scope, crypto.randomUUID(), () => {})).rejects.toThrow();
    await expect(f.gate.complete(scope, pause.id, () => { throw new Error("own session changed"); })).rejects.toThrow();
    expect(await f.gate.isAllowed(scope)).toBe(false);
    await f.gate.complete(scope, pause.id, () => {});
    f.gate.assertAllowed(scope);
    expect(await new SharedUnlockPreferenceGate(f.storage).isAllowed(scope)).toBe(true);
  });
  it("never lets a late save erase a newer local OFF", async () => {
    const f = setup(), first = f.gate.pause(scope); await first.persisted;
    const second = f.gate.pause(scope);
    await expect(f.gate.complete(scope, first.id, () => {})).rejects.toThrow();
    await second.persisted;
    expect(f.values[key]).toMatchObject({ pauseId: second.id });
    expect(await f.gate.isAllowed(scope)).toBe(false);
  });
  it("restores persistent denial if own session changes while clearing a pause", async () => {
    const f = setup(), pause = f.gate.pause(scope); await pause.persisted;
    let live = true;
    f.storage.set.mockImplementationOnce(async next => {
      Object.assign(f.values, structuredClone(next)); live = false;
    });
    await expect(f.gate.complete(scope, pause.id, () => { if (!live) throw new Error("own session changed"); })).rejects.toThrow();
    expect(await new SharedUnlockPreferenceGate(f.storage).isAllowed(scope)).toBe(false);
  });
  it("does not pause another account or API environment", async () => {
    const f = setup(); await f.gate.pause(scope).persisted;
    expect(await f.gate.isAllowed({ ...scope, apiUrl: "https://other-api.test" })).toBe(true);
    expect(await f.gate.isAllowed({ ...scope, accountId: "22222222-2222-4222-8222-222222222222" })).toBe(true);
  });
  it("fails closed on corrupt or substituted persistent metadata", async () => {
    const f = setup(); f.values[key] = { version: 1, ...scope, accountId: "22222222-2222-4222-8222-222222222222", pauseId: null };
    await expect(f.gate.isAllowed(scope)).rejects.toThrow();
    expect(() => f.gate.assertAllowed(scope)).toThrow();
    f.values[key] = { version: 1, ...scope, pauseId: null, unexpected: true };
    await expect(f.gate.isAllowed(scope)).rejects.toThrow();
  });
  it("re-reads another document's invalidation instead of trusting event payloads", async () => {
    const f = setup(); await f.gate.isAllowed(scope);
    const other = new SharedUnlockPreferenceGate(f.storage), pause = other.pause(scope); await pause.persisted;
    f.gate.refreshExternalKey(key);
    expect(() => f.gate.assertAllowed(scope)).toThrow();
    expect(await f.gate.isAllowed(scope)).toBe(false);
    await other.complete(scope, pause.id, () => {});
    f.gate.refreshExternalKey(key);
    expect(await f.gate.isAllowed(scope)).toBe(true);
  });
});
