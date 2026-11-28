# Extension telemetry

The distributed extension has no PostHog SDK and general capture is disabled.
The only exceptions are the anonymous compatibility reports below.
`EXTENSION_TELEMETRY_RELEASED` is a compile-time false gate. The reserved
`setAnalyticsTransport` hook does not retain or call its argument; a project key
alone also cannot enable capture. Calls create no event object, identifier,
persistent analytics record or offline queue. Tests cover the key-plus-transport
attempt to bypass that boundary.

Autofill, native messaging and synchronization work independently of analytics.
Page URLs, paths, query strings, browsing history, DOM, form values, account
identifiers and Vault contents are never analytics payloads. The only site data
ever sent is a bare public hostname (or registrable domain) in the compatibility
reports below. The existing `ex:` event-name vocabulary is a
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

## Anonymous sign-in compatibility reports

Product-owner decision 2026-11-26: to learn which provider sign-in screens and
which OAuth providers Palladin does not handle yet, the worker may send two
diagnostic events with the same transport, key, release gates, random
per-event `distinct_id`, disabled person profile and GeoIP, 500-key worker cap
and fail-silent behavior as the site-compatibility report.

- `ex:signin:account-not-observed`, once per sign-in flow, when a supported
  provider round trip finished without Palladin reading the account on the
  provider's page. Allowlist: `host` (bare public hostname of the service the
  user signs in to), `provider`, `provider_host` (bare public hostname of the
  last provider sign-in page, or `none`), `screen` (`identifier`, `password`,
  `account-chooser`, `consent`, `unknown` or `none`) and, when a screen was
  seen, the booleans `identifier_field`, `password_field`, `email_attribute`
  and `email_text`, plus the extension version.
- `ex:signin:provider-unsupported` when a top-frame document is an OAuth/OIDC
  authorization request (`client_id`, `redirect_uri` and `response_type` or
  `scope` parameter names) on a host that is not a supported provider.
  Allowlist: `host` = registrable domain of that host only (no tenant
  subdomain), plus the extension version.
- Hosts come only from browser-authored document URLs. The provider page sends
  only the value-free screen shape (`ProviderScreenShape` flags); no account,
  text, attribute, field value, path, query, OAuth parameter value, Entry,
  Vault or installation identifier is sent. Incognito tabs are not observed.

