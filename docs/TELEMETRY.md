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

## Diagnostics versus product analytics

Product-owner policy 2026-11-23:

- **Product analytics** (how people use the product) requires the single
  account-wide `product_analytics` consent, asked the same way on every client.
  The extension asks once after unlock and offers the same choice in Settings,
  with per-installation activation, withdrawal and freshness as on web/mobile
  (see the backend `docs/architecture/consent-and-analytics.md`). The backend
  scope `palladin_web_mobile` and consent sources must be extended to the
  extension, with a new notice version, before the first extension product
  analytics event ships. The extension has no such event today, so this flow
  is not implemented yet.
- **Diagnostics and errors** (where Palladin fails) are sent from every
  installation without that consent, minimized and unlinkable to a person, as
  in the compatibility report below.

Any new event must be classified as one of the two before implementation. Store disclosures and privacy
information must be reviewed before release. There is no advance cookie banner
for a feature that does not collect analytics.

## Anonymous site-compatibility report

Diagnostics (product-owner decision 2026-11-23, not consent-gated): to learn
which public sites break Palladin's login flow, the worker may send `ex:autofill:submit-action-missing` when an
explicit "Log in" filled the form but found no unique enabled sign-in action.
The purpose is service quality per site, not user tracking.

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
