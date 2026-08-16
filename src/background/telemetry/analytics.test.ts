import { afterEach, describe, expect, it, vi } from "vitest";

import { buildEventName, capture } from "./analytics";

describe("buildEventName", () => {
  it("prefixes the ex component and joins with colons", () => {
    expect(buildEventName("vault", "autofill-used")).toBe("ex:vault:autofill-used");
  });
});

describe("event-name typing", () => {
  it("bans *-viewed event names at compile time", () => {
    // The generic constraint turns a `-viewed` name into `never`, so this line
    // must be a type error — @ts-expect-error fails the build if the ban regresses.
    // Runs as a no-op at runtime (no PostHog key configured in tests).
    // @ts-expect-error '*-viewed' events are forbidden (Analytics rule 5)
    capture("vault", "list-viewed");
  });
});

describe("capture — enablement", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../config/env");
  });

  it("forwards ex:-prefixed events to the transport when a key is configured", async () => {
    vi.resetModules();
    vi.doMock("../config/env", () => ({
      env: { apiUrl: "", posthogKey: "phc_test", posthogHost: "" },
    }));
    const mod = await import("./analytics");
    const events: { name: string; props?: unknown }[] = [];
    mod.setAnalyticsTransport((e) => events.push(e));

    mod.capture("vault", "autofill-used", { count: 1 });

    expect(mod.isAnalyticsEnabled()).toBe(true);
    expect(events).toEqual([{ name: "ex:vault:autofill-used", props: { count: 1 } }]);
  });

  it("is a pure no-op when no PostHog key is configured", async () => {
    vi.resetModules();
    vi.doMock("../config/env", () => ({
      env: { apiUrl: "", posthogKey: "", posthogHost: "" },
    }));
    const mod = await import("./analytics");
    const events: unknown[] = [];
    mod.setAnalyticsTransport((e) => events.push(e));

    mod.capture("vault", "credential-captured");

    expect(mod.isAnalyticsEnabled()).toBe(false);
    expect(events).toEqual([]);
  });
});
