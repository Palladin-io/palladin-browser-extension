import { describe, expect, it, vi } from "vitest";
import { combineAbortSignals } from "./combine-abort-signals";

describe("combineAbortSignals", () => {
  it("uses the first already-aborted input without subscribing to live inputs", () => {
    const live = new AbortController(), first = new AbortController(), second = new AbortController();
    const subscribe = vi.spyOn(live.signal, "addEventListener");
    first.abort("first"); second.abort("second");
    const signal = combineAbortSignals([live.signal, first.signal, second.signal]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("first");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("cancels for input %i and removes every upstream subscription before notifying consumers", index => {
    const inputs = [new AbortController(), new AbortController(), new AbortController()];
    const subscriptions = inputs.map(input => vi.spyOn(input.signal, "addEventListener"));
    const removals = inputs.map(input => vi.spyOn(input.signal, "removeEventListener"));
    const signal = combineAbortSignals(inputs.map(input => input.signal));
    const cancelled = vi.fn(() => {
      removals.forEach((remove, i) => expect(remove).toHaveBeenCalledWith("abort", subscriptions[i]!.mock.calls[0]![1]));
    });
    signal.addEventListener("abort", cancelled);
    expect(signal.aborted).toBe(false);
    const reason = new Error("Operation retired");
    inputs[index]!.abort(reason);
    inputs.forEach(input => input.abort("later"));
    expect(signal.reason).toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
    removals.forEach(remove => expect(remove).toHaveBeenCalledOnce());
  });

  it("releases successful operations without aborting a shared route or sibling operation", () => {
    const route = new AbortController(), first = new AbortController(), second = new AbortController();
    const subscribe = vi.spyOn(route.signal, "addEventListener");
    const remove = vi.spyOn(route.signal, "removeEventListener");
    const one = combineAbortSignals([route.signal, first.signal, route.signal]);
    const two = combineAbortSignals([route.signal, second.signal]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    first.abort(); // Operation owner retires its signal in finally, including success.
    expect(one.aborted).toBe(true);
    expect(two.aborted).toBe(false);
    expect(route.signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    route.abort("route closed");
    expect(two.reason).toBe("route closed");
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
