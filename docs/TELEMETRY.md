# Extension telemetry

The distributed extension has no PostHog SDK and general capture is disabled.
The one exception is the anonymous site-compatibility report below.
`EXTENSION_TELEMETRY_RELEASED` is a compile-time false gate. The reserved
`setAnalyticsTransport` hook does not retain or call its argument; a project key
alone also cannot enable capture. Calls create no event object, identifier,
persistent analytics record or offline queue. Tests cover the key-plus-transport
attempt to bypass that boundary.

Autofill, native messaging and synchronization work independently of analytics.
Page URLs, paths, query strings, browsing history, DOM, form values, account
identifiers and Vault contents are never analytics payloads. The only site data
ever sent is the bare public hostname in the compatibility report below. The existing `ex:` event-name vocabulary is a
reserved interface, not evidence that events are collected.

Future telemetry requires an explicit product contract for purpose and scope,
prior consent, per-installation activation, withdrawal, freshness, payload
allowlisting and all startup/background paths. Store disclosures and privacy
information must be reviewed before release. There is no advance cookie banner
for a feature that does not collect analytics.

## Anonymous site-compatibility report

Product-owner decision 2026-11-23: to learn which public sites break Palladin's
login flow, the worker may send `ex:autofill:submit-action-missing` when an
explicit "Log in" filled the form but found no unique enabled sign-in action.
The purpose is service quality per site, not user tracking.

Product-owner decision 2026-11-25 adds `ex:autofill:signin-prompt-missing`: an unlocked
user with a matching Entry submitted a password by hand, or filled from the popup, on a
page where no sign-in toast was offered. The content script sends a value-free signal;
the worker checks the Entry match itself. Signed-in visits, muted and dismissed hosts
and registration URLs are not reported. It uses the same payload and limits below.

- Payload allowlist: event name, bare public HTTPS hostname, extension version.
  No path, query, fragment, port, page title, DOM, field value, Entry, Vault,
  account, installation or user identifier.
- `distinct_id` is a fresh random UUID per event; `$process_person_profile` is
  false and GeoIP enrichment is disabled, so events cannot be joined into a
  person or a browsing history.
- The worker derives the host from the browser-authenticated inline frame URL
  (`inlineAutofillSource`). The content-script message is value-free and cannot
  name a site.
- Only registrable public domains are sent: no `http:`, IP addresses, localhost
  or single-label intranet hosts. Each host is reported at most once per worker
  lifetime and at most 500 hosts per worker.
- Sending requires a build-injected public project key (`VITE_POSTHOG_KEY`);
  tracked configuration keeps it empty. Failures are ignored and never retried
  or queued.
- Release gates: enable "Discard client IP data" in the receiving PostHog
  project, and update store data-use disclosures and privacy information before
  shipping a build with a key. Any additional event or property needs a new
  product decision and this allowlist updated first.
