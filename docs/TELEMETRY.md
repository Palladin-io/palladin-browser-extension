# Extension telemetry

The distributed extension has no active PostHog SDK or capture transport.
`EXTENSION_TELEMETRY_RELEASED` is a compile-time false gate. The reserved
`setAnalyticsTransport` hook does not retain or call its argument; a project key
alone also cannot enable capture. Calls create no event object, identifier,
persistent analytics record or offline queue. Tests cover the key-plus-transport
attempt to bypass that boundary.

Autofill, native messaging and synchronization work independently of analytics.
Page URLs, browsing history, visited domains, DOM, form values and Vault contents
are never analytics payloads. The existing `ex:` event-name vocabulary is a
reserved interface, not evidence that events are collected.

Future telemetry requires an explicit product contract for purpose and scope,
prior consent, per-installation activation, withdrawal, freshness, payload
allowlisting and all startup/background paths. Store disclosures and privacy
information must be reviewed before release. There is no advance cookie banner
for a feature that does not collect analytics.
