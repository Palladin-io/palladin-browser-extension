import { describe, expect, it, vi } from "vitest";

import { createFormCompatibilityReporter, createSignInCompatibilityReporter } from "./form-compatibility";

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

describe("anonymous sign-in compatibility reports", () => {
  function signIn(projectKey = "phc_public") {
    const send = vi.fn(async (_url: string, _body: string) => undefined);
    const report = createSignInCompatibilityReporter({ projectKey, ingestHost: "https://eu.i.posthog.com", extensionVersion: "0.1.3", send, randomId: () => "random" });
    return { report, send, bodies: () => send.mock.calls.map(([, body]) => JSON.parse(body) as Record<string, unknown>) };
  }
  const screen = { kind: "account-chooser" as const, identifierField: false, passwordField: false, emailAttribute: true, emailText: true };

  it("sends only hosts, the provider and value-free screen flags for an unread account", () => {
    const { report, send, bodies } = signIn();
    report({ event: "account-not-observed", serviceUrl: "https://App.Example.com/login?next=%2Fbilling&email=ada%40example.org",
      provider: "google", providerUrl: "https://accounts.google.com/v3/signin/accountchooser?Email=ada%40example.org", screen });
    expect(bodies()[0]).toEqual({ api_key: "phc_public", event: "ex:signin:account-not-observed", distinct_id: "random",
      properties: { host: "app.example.com", provider: "google", provider_host: "accounts.google.com", screen: "account-chooser",
        identifier_field: false, password_field: false, email_attribute: true, email_text: true,
        extension_version: "0.1.3", $process_person_profile: false, $geoip_disable: true } });
    expect(send.mock.calls[0]![1]).not.toMatch(/ada|example\.org|billing|accountchooser|login/);
  });

  it("marks a silent return without a provider screen", () => {
    const { report, bodies } = signIn();
    report({ event: "account-not-observed", serviceUrl: "https://app.example.com/", provider: "github", providerUrl: null, screen: null });
    expect(bodies()[0]!.properties).toEqual(expect.objectContaining({ provider: "github", provider_host: "none", screen: "none" }));
    expect(bodies()[0]!.properties).not.toHaveProperty("email_text");
  });

  it("reports an unsupported provider by registrable domain only, once", () => {
    const { report, bodies } = signIn();
    report({ event: "provider-unsupported", authorizationUrl: "https://acme.okta.com/oauth2/v1/authorize?client_id=secret&login_hint=ada%40example.org" });
    report({ event: "provider-unsupported", authorizationUrl: "https://other.okta.com/oauth2/v1/authorize?client_id=c" });
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toEqual(expect.objectContaining({ event: "ex:signin:provider-unsupported", properties: expect.objectContaining({ host: "okta.com" }) }));
    expect(JSON.stringify(bodies())).not.toMatch(/acme|secret|ada/);
  });

  it.each(["http://example.com/authorize", "https://192.168.1.10/authorize", "https://localhost/authorize"])("drops a non-public provider URL %s", url => {
    const { report, send } = signIn();
    report({ event: "provider-unsupported", authorizationUrl: url });
    report({ event: "account-not-observed", serviceUrl: url, provider: "google", providerUrl: null, screen: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing without a build-injected project key", () => {
    const { report, send } = signIn("");
    report({ event: "provider-unsupported", authorizationUrl: "https://acme.okta.com/oauth2/v1/authorize?client_id=c" });
    expect(send).not.toHaveBeenCalled();
  });
});
