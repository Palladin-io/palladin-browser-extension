/**
 * Anonymous site-compatibility signal (product-owner decision 2026-11-23):
 * which public sites break Palladin's login flow, never who uses them.
 * Only this allowlisted event leaves the extension; general `capture()` stays
 * disabled. See docs/TELEMETRY.md.
 */

import { registrableDomain } from "@shared/security/domain";

export type FormCompatibilityIssue = "submit-action-missing" | "signin-prompt-missing";

export interface FormCompatibilityConfig {
  /** Build-injected public PostHog project key; empty disables reporting. */
  readonly projectKey: string;
  readonly ingestHost: string;
  readonly extensionVersion: string;
  readonly send?: (url: string, body: string) => Promise<unknown>;
  readonly randomId?: () => string;
}

const MAX_REPORTED_PER_WORKER = 500;

/** `frameUrl` must come from the browser-authenticated sender, never from page data. */
export function createFormCompatibilityReporter(config: FormCompatibilityConfig) {
  const reported = new Set<string>();
  const send = config.send
    ?? ((url: string, body: string) => fetch(url, { method: "POST", body, credentials: "omit", keepalive: true }));
  const randomId = config.randomId ?? (() => crypto.randomUUID());

  return (frameUrl: string, issue: FormCompatibilityIssue): void => {
    if (config.projectKey.length === 0) return;
    const host = publicHttpsHost(frameUrl);
    const key = `${issue}:${host}`;
    if (host === null || reported.has(key) || reported.size >= MAX_REPORTED_PER_WORKER) return;
    reported.add(key);
    // A fresh random distinct_id per event and no person profile: events cannot
    // be joined into a per-user browsing history.
    const body = JSON.stringify({
      api_key: config.projectKey,
      event: `ex:autofill:${issue}`,
      distinct_id: randomId(),
      properties: {
        host,
        extension_version: config.extensionVersion,
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    void send(`${config.ingestHost.replace(/\/+$/, "")}/i/v0/e/`, body).catch(() => undefined);
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
