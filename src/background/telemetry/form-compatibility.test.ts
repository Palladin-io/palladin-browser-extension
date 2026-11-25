import { describe, expect, it, vi } from "vitest";

import { createFormCompatibilityReporter } from "./form-compatibility";

function reporter(projectKey = "phc_public") {
  const send = vi.fn(async (_url: string, _body: string) => undefined);
  let id = 0;
  const report = createFormCompatibilityReporter({
    projectKey, ingestHost: "https://eu.i.posthog.com/", extensionVersion: "0.1.3",
    send, randomId: () => `random-${++id}`,
  });
  const bodies = () => send.mock.calls.map(([, body]) => JSON.parse(body) as Record<string, unknown>);
  return { report, send, bodies };
}

describe("anonymous form-compatibility reports", () => {
  it("reports a missing sign-in prompt with the same value-free fields", () => {
    const bodies: string[] = [];
    const report = createFormCompatibilityReporter({ projectKey: "phc", ingestHost: "https://eu.i.posthog.com", extensionVersion: "0.1.0",
      randomId: () => "random", send: async (_url, body) => { bodies.push(body); } });
    report("https://login.example.com/path?user=ada#x", "signin-prompt-missing");
    report("https://login.example.com/other", "signin-prompt-missing");
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ api_key: "phc", event: "ex:autofill:signin-prompt-missing", distinct_id: "random",
      properties: { host: "login.example.com", extension_version: "0.1.0", $process_person_profile: false, $geoip_disable: true } });
  });
  it("sends only the event, the bare host and the extension version", () => {
    const { report, send, bodies } = reporter();
    report("https://IdMsa.Apple.com./appleauth/auth/authorize/signin?frame_id=abc&email=ada%40example.com#x", "submit-action-missing");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(bodies()[0]).toEqual({
      api_key: "phc_public",
      event: "ex:autofill:submit-action-missing",
      distinct_id: "random-1",
      properties: {
        host: "idmsa.apple.com",
        extension_version: "0.1.3",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    expect(send.mock.calls[0]![1]).not.toMatch(/appleauth|frame_id|ada|example\.com/);
  });

  it("uses an unlinkable identifier per event and reports each host once per worker", () => {
    const { report, bodies } = reporter();
    report("https://a.example.org/login", "submit-action-missing");
    report("https://a.example.org/other", "submit-action-missing");
    report("https://b.example.org/login", "submit-action-missing");

    expect(bodies().map(body => (body.properties as { host: string }).host)).toEqual(["a.example.org", "b.example.org"]);
    expect(new Set(bodies().map(body => body.distinct_id)).size).toBe(2);
  });

  it.each([
    "http://example.com/login",
    "https://localhost/login",
    "https://192.168.1.10/login",
    "https://intranet/login",
    "chrome-extension://abc/popup.html",
    "not a url",
  ])("never reports a non-public or insecure page: %s", (url) => {
    const { report, send } = reporter();
    report(url, "submit-action-missing");
    expect(send).not.toHaveBeenCalled();
  });

  it("is inert without a build-injected project key", () => {
    const { report, send } = reporter("");
    report("https://example.com/login", "submit-action-missing");
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows transport failures", async () => {
    const send = vi.fn(async () => { throw new Error("offline"); });
    const report = createFormCompatibilityReporter({ projectKey: "phc", ingestHost: "https://eu.i.posthog.com", extensionVersion: "0.1.3", send });
    expect(() => report("https://example.com/", "submit-action-missing")).not.toThrow();
    await Promise.resolve();
  });
});
