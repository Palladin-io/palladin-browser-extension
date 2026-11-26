/**
 * Anonymous site-compatibility signal (product-owner decision 2026-11-23):
 * which public sites break Palladin's login flow, never who uses them.
 * Only this allowlisted event leaves the extension; general `capture()` stays
 * disabled. See docs/TELEMETRY.md.
 */

import type { ProviderScreenShape } from "@shared/messaging/federated-signin";
import { registrableDomain } from "@shared/security/domain";

export type FormCompatibilityIssue = "submit-action-missing";

export interface FormCompatibilityConfig {
  /** Build-injected public PostHog project key; empty disables reporting. */
  readonly projectKey: string;
  readonly ingestHost: string;
  readonly extensionVersion: string;
  readonly send?: (url: string, body: string) => Promise<unknown>;
  readonly randomId?: () => string;
}

const MAX_REPORTED_PER_WORKER = 500;

type DiagnosticValue = string | number | boolean;

/** One allowlisted, value-free event per key and worker; `host` is already reduced to a public hostname. */
function createDiagnosticSender(config: FormCompatibilityConfig) {
  const reported = new Set<string>();
  const send = config.send
    ?? ((url: string, body: string) => fetch(url, { method: "POST", body, credentials: "omit", keepalive: true }));
  const randomId = config.randomId ?? (() => crypto.randomUUID());

  return (event: string, host: string, properties: Readonly<Record<string, DiagnosticValue>> = {}): void => {
    if (config.projectKey.length === 0) return;
    const key = [event, host, ...Object.values(properties)].join(":");
    if (reported.has(key) || reported.size >= MAX_REPORTED_PER_WORKER) return;
    reported.add(key);
    // A fresh random distinct_id per event and no person profile: events cannot
    // be joined into a per-user browsing history.
    const body = JSON.stringify({
      api_key: config.projectKey,
      event,
      distinct_id: randomId(),
      properties: {
        host,
        ...properties,
        extension_version: config.extensionVersion,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    void send(`${config.ingestHost.replace(/\/+$/, "")}/i/v0/e/`, body).catch(() => undefined);
  };
}

/** `frameUrl` must come from the browser-authenticated sender, never from page data. */
export function createFormCompatibilityReporter(config: FormCompatibilityConfig) {
  const report = createDiagnosticSender(config);
  return (frameUrl: string, issue: FormCompatibilityIssue): void => {
    const host = publicHttpsHost(frameUrl);
    if (host !== null) report(`ex:autofill:${issue}`, host);
  };
}

export type SignInDiagnostic =
  /** A completed provider sign-in where Palladin did not read the account from the provider's page. */
  | { readonly event: "account-not-observed"; readonly serviceUrl: string; readonly provider: string;
      readonly providerUrl: string | null; readonly screen: ProviderScreenShape | null }
  /** An OAuth authorization request to a provider Palladin does not support yet. */
  | { readonly event: "provider-unsupported"; readonly authorizationUrl: string };

/**
 * Sign-in compatibility (product-owner decision 2026-11-26): which provider
 * screens and providers Palladin does not handle yet. URLs come only from
 * browser-authenticated documents; only public hostnames and value-free flags leave.
 */
export function createSignInCompatibilityReporter(config: FormCompatibilityConfig) {
  const report = createDiagnosticSender(config);
  return (diagnostic: SignInDiagnostic): void => {
    if (diagnostic.event === "provider-unsupported") {
      const host = publicHttpsHost(diagnostic.authorizationUrl);
      // The registrable domain names the provider without a tenant or employer subdomain.
      const domain = host === null ? null : registrableDomain(host);
      if (domain !== null) report("ex:signin:provider-unsupported", domain);
      return;
    }
    const host = publicHttpsHost(diagnostic.serviceUrl);
    if (host === null) return;
    const providerHost = diagnostic.providerUrl === null ? null : publicHttpsHost(diagnostic.providerUrl);
    const screen = diagnostic.screen;
    report("ex:signin:account-not-observed", host, {
      provider: diagnostic.provider,
      provider_host: providerHost ?? "none",
      screen: screen?.kind ?? "none",
      ...(screen ? { identifier_field: screen.identifierField, password_field: screen.passwordField,
        email_attribute: screen.emailAttribute, email_text: screen.emailText } : {}),
    });
  };
}

/** Hostname only (no path/query/port); public registrable domains only, so no intranet, IP or localhost. */
function publicHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return parsed.protocol === "https:" && registrableDomain(host) !== null ? host : null;
  } catch {
    return null;
  }
}
